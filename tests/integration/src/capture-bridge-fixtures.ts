/**
 * Captures a real response for every bridge method into tests/fixtures/bridge/,
 * so CI can check the wire contract on platforms that have no Rack.
 *
 * The tool-level gate (contract-smoke) needs live Rack on macOS, which means
 * the one class of defect it catches — a producer drifting away from its
 * declared schema — is invisible to CI on every platform. These fixtures close
 * that: packages/schemas/test/bridge-fixtures.test.ts strict-parses each one
 * against BRIDGE_METHODS[method].result, which until now was declared for all
 * 19 methods and used only by codegen. That catches drift from either side —
 * a producer that stops matching its schema, and a schema edit that stops
 * matching the real wire.
 *
 * Refresh with: pnpm --filter @rackmcp/integration run capture
 * (requires the installed Rack; the fixtures are committed).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { BridgeClient, BridgeRequestError, loadPairingSecret } from "@rackmcp/protocol";
import { BRIDGE_METHODS } from "@rackmcp/schemas";
import { RackHarness } from "./harness.js";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const FIXTURE_DIR = join(REPO_ROOT, "tests", "fixtures", "bridge");
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

const captured = new Set<string>();
function save(method: string, payload: unknown): void {
  writeFileSync(join(FIXTURE_DIR, `${method}.json`), JSON.stringify(payload, null, 2) + "\n");
  captured.add(method);
}

const harness = new RackHarness({ baseDir: scratch, name: "capture" });
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
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const instance = await harness.waitForInstance();
  const secret = loadPairingSecret(harness.rackmcpDir);
  const client = new BridgeClient({ clientName: "capture", clientVersion: "0.1.0" });
  await client.connect(instance.manifest.port);
  await client.authenticate(secret);

  const status = await waitReady(client);
  save("status.get", status);
  const scope = () => ({
    instanceId: status.instanceId as string,
    sessionId: status.sessionId as string,
    patchEpoch: 1,
  });

  save("metrics.get", await client.request("metrics.get", {}));
  save("catalog.listModels", await client.request("catalog.listModels", { limit: 3 }));
  save(
    "catalog.inspectModel",
    await client.request("catalog.inspectModel", { pluginSlug: "Fundamental", modelSlug: "VCO" }),
  );
  save("patch.fingerprint", await client.request("patch.fingerprint", {}));
  save("probe.list", await client.request("probe.list", {}));

  // Writer lease: acquire, renew, and hold it for the mutating methods below.
  const lease = (await client.request("lease.acquire", { clientName: "capture" })) as {
    leaseId: string;
  };
  save("lease.acquire", lease);
  save("lease.renew", await client.request("lease.renew", { leaseId: lease.leaseId }));

  // A module to inspect, and a plan to preview and commit.
  const addOps = [
    { op: "add_module", pluginSlug: "Fundamental", modelSlug: "VCO", alias: "vco", placement: "auto" },
  ];
  const preview = (await client.request("txn.preview", {
    scope: scope(),
    label: "Capture fixture",
    operations: addOps,
  })) as { plan: unknown; planHash: string; baseFingerprint: string };
  save("txn.preview", preview);

  const commitOpId = randomUUID();
  const commit = (await client.request(
    "txn.commit",
    {
      scope: scope(),
      operationId: commitOpId,
      plan: preview.plan,
      planHash: preview.planHash,
      expectedFingerprint: preview.baseFingerprint,
    },
    { operationId: commitOpId },
  )) as { aliasToModuleId?: Record<string, string> };
  save("txn.commit", commit);

  const snapshot = (await client.request("patch.snapshot", {})) as {
    modules: Array<{ moduleId: string; modelSlug: string }>;
  };
  save("patch.snapshot", snapshot);
  const vco = snapshot.modules.find((m) => m.modelSlug === "VCO");
  ok("captured a VCO to inspect", vco !== undefined);
  if (vco) {
    save(
      "module.inspect",
      await client.request("module.inspect", { scope: scope(), moduleId: vco.moduleId }),
    );
  }

  // probe.read against a Probe slot: attach one through a transaction first.
  const probePreview = (await client.request("txn.preview", {
    scope: scope(),
    label: "Capture probe",
    operations: [
      { op: "add_module", pluginSlug: "RackMCP", modelSlug: "Probe", alias: "probe", placement: "auto" },
    ],
  })) as { plan: unknown; planHash: string; baseFingerprint: string };
  const probeOpId = randomUUID();
  const probeCommit = (await client.request(
    "txn.commit",
    {
      scope: scope(),
      operationId: probeOpId,
      plan: probePreview.plan,
      planHash: probePreview.planHash,
      expectedFingerprint: probePreview.baseFingerprint,
    },
    { operationId: probeOpId },
  )) as { aliasToModuleId?: Record<string, string> };
  const probeModuleId = probeCommit.aliasToModuleId?.probe;
  ok("captured a Probe module", typeof probeModuleId === "string");
  if (probeModuleId) {
    save(
      "probe.read",
      await client.request("probe.read", {
        scope: scope(),
        probeModuleId,
        probeInputId: 0,
      }),
    );
  }

  // Patch-file methods. saveCopy leaves the current patch path alone; save,
  // load and clear each bump the epoch, so re-read the scope as we go.
  // Talking to the bridge directly skips the MCP server, which is what
  // normally ensures the patches root exists.
  mkdirSync(join(harness.userDir, "patches"), { recursive: true });
  const savePath = join(harness.userDir, "patches", "capture.vcv");
  const copyPath = join(harness.userDir, "patches", "capture-copy.vcv");
  save(
    "patchfile.saveCopy",
    await client.request(
      "patchfile.saveCopy",
      { scope: scope(), path: copyPath, operationId: randomUUID() },
      { operationId: randomUUID() },
    ),
  );
  save(
    "patchfile.save",
    await client.request(
      "patchfile.save",
      { scope: scope(), path: savePath, operationId: randomUUID() },
      { operationId: randomUUID() },
    ),
  );
  const cleared = (await client.request(
    "patchfile.clear",
    { scope: scope(), operationId: randomUUID() },
    { operationId: randomUUID() },
  )) as { patchEpoch?: number };
  save("patchfile.clear", cleared);
  const loadScope = { ...scope(), patchEpoch: cleared.patchEpoch ?? 1 };
  save(
    "patchfile.load",
    await client.request(
      "patchfile.load",
      { scope: loadScope, path: savePath, operationId: randomUUID() },
      { operationId: randomUUID() },
    ),
  );

  // txn.undoLast needs a transaction at the top of history: the load replaced
  // the patch, so make a fresh one and immediately undo it.
  const afterLoad = (await client.request("status.get", {})) as { patchEpoch: number };
  const undoScope = { ...scope(), patchEpoch: afterLoad.patchEpoch };
  const undoPrev = (await client.request("txn.preview", {
    scope: undoScope,
    label: "Capture undo",
    operations: addOps,
  })) as { plan: unknown; planHash: string; baseFingerprint: string };
  const undoTarget = randomUUID();
  await client.request(
    "txn.commit",
    {
      scope: undoScope,
      operationId: undoTarget,
      plan: undoPrev.plan,
      planHash: undoPrev.planHash,
      expectedFingerprint: undoPrev.baseFingerprint,
    },
    { operationId: undoTarget },
  );
  save(
    "txn.undoLast",
    await client.request(
      "txn.undoLast",
      { scope: undoScope, expectedOperationId: undoTarget, operationId: randomUUID() },
      { operationId: randomUUID() },
    ),
  );

  save("lease.release", await client.request("lease.release", { leaseId: lease.leaseId }));

  // Coverage: a method with no fixture is a silent hole in the CI check.
  const missing = Object.keys(BRIDGE_METHODS).filter((m) => !captured.has(m));
  ok(
    `captured every bridge method (${captured.size}/${Object.keys(BRIDGE_METHODS).length})`,
    missing.length === 0,
    missing.join(", "),
  );

  client.close();
} catch (e) {
  console.error("CAPTURE FAILURE:", e);
  console.error("Rack log tail:\n" + harness.logTail());
  failures++;
} finally {
  await harness.quit();
}
console.error(failures ? `BRIDGE CAPTURE: FAILED (${failures})` : "BRIDGE CAPTURE: PASSED");
process.exitCode = failures ? 1 : 0;
