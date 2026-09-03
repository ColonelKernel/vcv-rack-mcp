/**
 * Phase 4 live test: read-only snapshot and catalog against real Rack.
 * The seeded patch contains exactly one RackMCP-Bridge module.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeClient, BridgeRequestError, loadPairingSecret } from "@rackmcp/protocol";
import { PatchSnapshot } from "@rackmcp/schemas";
import { RackHarness } from "./harness.js";

const scratch = process.env.RACKMCP_TEST_DIR ?? mkdtempSync(join(tmpdir(), "rackmcp-"));
let failures = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  if (!cond) {
    console.error(`FAIL ${name} ${detail}`);
    failures++;
  } else {
    console.error(`ok   ${name}${detail ? ` (${detail})` : ""}`);
  }
}

const harness = new RackHarness({ baseDir: scratch, name: "snap" });
harness.prepare();
harness.launch();

async function waitReady(client: BridgeClient): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      return (await client.request("status.get", {})) as Record<string, unknown>;
    } catch (e) {
      if (e instanceof BridgeRequestError && e.rpcError.code === "BRIDGE_NOT_READY") {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      throw e;
    }
  }
  throw new Error("bridge never became ready");
}

try {
  const instance = await harness.waitForInstance();
  const secret = loadPairingSecret(harness.rackmcpDir);
  const client = new BridgeClient({ clientName: "snap", clientVersion: "0.1.0" });
  await client.connect(instance.manifest.port);
  await client.authenticate(secret);
  await waitReady(client);

  // Catalog: Core + Fundamental must be present and paginated.
  const page1 = (await client.request("catalog.listModels", { limit: 5 })) as {
    models: Array<Record<string, string>>;
    totalModels: number;
    nextCursor: string | null;
  };
  ok("catalog paginates", page1.models.length === 5 && page1.totalModels > 5, `total ${page1.totalModels}`);
  ok("catalog has cursor", typeof page1.nextCursor === "string");
  ok(
    "catalog items carry description and tags",
    typeof page1.models[0]!.description === "string" && Array.isArray(page1.models[0]!.tags as unknown),
  );

  const all: Array<Record<string, string>> = [...page1.models];
  let cursor = page1.nextCursor;
  let guard = 0;
  while (cursor && guard++ < 100) {
    const page = (await client.request("catalog.listModels", { limit: 50, cursor })) as {
      models: Array<Record<string, string>>;
      nextCursor: string | null;
    };
    all.push(...page.models);
    cursor = page.nextCursor;
  }
  ok("catalog full walk matches total", all.length === page1.totalModels, `${all.length}`);
  const hasVCO = all.some((m) => m.pluginSlug === "Fundamental" && m.modelSlug === "VCO");
  const hasAudio = all.some((m) => m.pluginSlug === "Core" && (m.modelSlug ?? "").startsWith("Audio"));
  ok("catalog contains Fundamental VCO", hasVCO);
  ok("catalog contains Core Audio", hasAudio);

  // Filtered catalog.
  const filtered = (await client.request("catalog.listModels", { query: "vco", limit: 100 })) as {
    models: Array<Record<string, string>>;
  };
  ok(
    "catalog filter works",
    filtered.models.length > 0 &&
      filtered.models.every((m) =>
        `${m.pluginSlug ?? ""} ${m.pluginName ?? ""} ${m.modelSlug ?? ""} ${m.modelName ?? ""}`
          .toLowerCase()
          .includes("vco"),
      ),
    `${filtered.models.length} matches`,
  );

  // Model inspection via temporary instantiation.
  const vcoMeta = (await client.request("catalog.inspectModel", {
    pluginSlug: "Fundamental",
    modelSlug: "VCO",
  })) as Record<string, unknown>;
  const vcoParams = vcoMeta.params as Array<Record<string, unknown>>;
  const vcoOutputs = vcoMeta.outputs as Array<Record<string, unknown>>;
  ok("inspectModel VCO params", vcoParams.length > 0, `${vcoParams.length} params`);
  ok("inspectModel VCO outputs", vcoOutputs.length > 0);
  ok("inspectModel discloses temp instantiation", vcoMeta.requiredTemporaryInstantiation === true);
  const vcoModel = vcoMeta.model as Record<string, unknown>;
  ok("inspectModel carries model metadata", vcoModel?.modelSlug === "VCO" && typeof vcoModel.description === "string");
  // Static model metadata only: no live-state fields leak in from the
  // temporary instance (its values are always defaults, its ports unconnected).
  ok("inspectModel params are model-shaped", vcoParams.every((prm) => !("value" in prm) && !("displayValue" in prm)));
  ok("inspectModel ports are model-shaped", vcoOutputs.every((prt) => !("connected" in prt) && !("channels" in prt)));
  ok("inspectModel first call is not cached", vcoMeta.cached === false);

  // Second call for the same model is served from the metadata cache, so it
  // does not instantiate the module on the UI thread again.
  const vcoMeta2 = (await client.request("catalog.inspectModel", {
    pluginSlug: "Fundamental",
    modelSlug: "VCO",
  })) as Record<string, unknown>;
  ok("inspectModel second call is cached", vcoMeta2.cached === true);
  // Same content, only `cached` differs. Compared field-wise rather than by
  // serialization, which would also be asserting jansson's key ordering.
  ok(
    "inspectModel cached payload matches",
    Object.keys(vcoMeta2).sort().join(",") === Object.keys(vcoMeta).sort().join(",") &&
      JSON.stringify(vcoMeta2.model) === JSON.stringify(vcoMeta.model) &&
      JSON.stringify(vcoMeta2.params) === JSON.stringify(vcoMeta.params) &&
      JSON.stringify(vcoMeta2.inputs) === JSON.stringify(vcoMeta.inputs) &&
      JSON.stringify(vcoMeta2.outputs) === JSON.stringify(vcoMeta.outputs),
  );

  // model not installed
  {
    let code = "";
    try {
      await client.request("catalog.inspectModel", { pluginSlug: "Nope", modelSlug: "Nope" });
    } catch (e) {
      if (e instanceof BridgeRequestError) code = e.rpcError.code;
    }
    ok("inspectModel unknown -> MODEL_NOT_INSTALLED", code === "MODEL_NOT_INSTALLED", code);
  }

  // Patch snapshot: seeded Bridge module present, real structure.
  const snap = (await client.request("patch.snapshot", {})) as Record<string, unknown>;
  const modules = snap.modules as Array<Record<string, unknown>>;
  ok("snapshot has modules", modules.length >= 1, `${modules.length} modules`);
  const bridge = modules.find((m) => m.isBridge === true);
  ok("snapshot finds Bridge module", bridge !== undefined);
  if (bridge) {
    ok("bridge moduleId is decimal string", /^\d+$/.test(bridge.moduleId as string));
    ok("bridge has grid position", bridge.gridPosition !== null);
    ok("bridge params array present", Array.isArray(bridge.params));
  }
  // The declared PatchSnapshot schema must match the real bridge wire shape.
  {
    const parsed = PatchSnapshot.safeParse(snap);
    ok(
      "snapshot matches PatchSnapshot schema",
      parsed.success,
      parsed.success
        ? ""
        : parsed.error.issues
            .slice(0, 8)
            .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
            .join("; "),
    );
  }
  ok("snapshot bridgeModuleCount", (snap.bridgeModuleCount as number) >= 1);
  ok(
    "snapshot fingerprint is 64 hex",
    typeof snap.fingerprint === "string" && /^[0-9a-f]{64}$/.test(snap.fingerprint as string),
  );
  ok("snapshot epoch is 1", snap.patchEpoch === 1);

  // Fingerprint is stable across two reads with no mutation.
  const fp1 = (await client.request("patch.fingerprint", {})) as { fingerprint: string };
  const fp2 = (await client.request("patch.fingerprint", {})) as { fingerprint: string };
  ok("fingerprint stable", fp1.fingerprint === fp2.fingerprint && fp1.fingerprint === snap.fingerprint);

  // Epoch guard: wrong expected epoch is rejected.
  {
    let code = "";
    try {
      await client.request("patch.snapshot", { expectedPatchEpoch: 999 });
    } catch (e) {
      if (e instanceof BridgeRequestError) code = e.rpcError.code;
    }
    ok("stale epoch guard rejects", code === "STALE_PATCH_EPOCH", code);
  }

  // Inspect the Bridge module directly.
  if (bridge) {
    const inspected = (await client.request("module.inspect", {
      moduleId: bridge.moduleId,
    })) as { module: Record<string, unknown> };
    ok("module.inspect returns the module", inspected.module.moduleId === bridge.moduleId);
  }
  // Unknown module id.
  {
    let code = "";
    try {
      await client.request("module.inspect", { moduleId: "999999" });
    } catch (e) {
      if (e instanceof BridgeRequestError) code = e.rpcError.code;
    }
    ok("module.inspect unknown -> MODULE_NOT_FOUND", code === "MODULE_NOT_FOUND", code);
  }

  client.close();
} catch (e) {
  console.error("SNAPSHOT SMOKE FAILURE:", e);
  console.error("Rack log tail:\n" + harness.logTail());
  failures++;
} finally {
  await harness.quit();
}
console.error(failures ? `SNAPSHOT SMOKE: FAILED (${failures})` : "SNAPSHOT SMOKE: PASSED");
process.exitCode = failures ? 1 : 0;
