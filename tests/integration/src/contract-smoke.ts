/**
 * Output-contract test: drive every tool in the registry against real Rack and
 * strict-parse each result against the tool's own declared output schema.
 *
 * The server validates tool output too (server.ts), but non-fatally — a
 * mismatch only writes `schemaValid: false` into the audit record and an error
 * line to stderr, so producer drift can sit in a green build indefinitely. The
 * other smokes read a handful of fields off each result and never notice.
 * This one fails the build instead, and it fails on *coverage* as well: a tool
 * added to the registry without an entry here is reported as unexercised, so
 * the census cannot silently go stale.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { TOOLS } from "@rackmcp/schemas";
import { RackHarness } from "./harness.js";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const SERVER_ENTRY = join(REPO_ROOT, "apps", "mcp-server", "dist", "index.js");
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
function sc(r: unknown): Record<string, unknown> {
  return (r as { structuredContent: Record<string, unknown> }).structuredContent;
}

/** Tools whose success payload was validated, and the drift found if any. */
const validated = new Set<string>();
const drift = new Map<string, string[]>();

const harness = new RackHarness({ baseDir: scratch, name: "contract" });
harness.prepare();
harness.launch();
const client = new Client({ name: "contract-test", version: "0.1.0" });
let transport: StdioClientTransport | null = null;

/**
 * Call a tool and strict-parse its structured result against the declared
 * output schema. Error results carry the error payload rather than the success
 * shape, so they are recorded as exercised but not schema-checked; pass
 * `expectError` to assert that an error was the point of the call.
 */
async function call(
  name: string,
  args: Record<string, unknown> = {},
  expectError = false,
): Promise<Record<string, unknown>> {
  const spec = TOOLS.find((t) => t.name === name);
  if (!spec) throw new Error(`unknown tool ${name}`);
  const raw = await client.callTool({ name, arguments: args });
  const structured = sc(raw) ?? {};
  const isError = (raw as { isError?: boolean }).isError === true;
  if (isError) {
    if (!expectError) {
      // An error result carries the error payload, not the success shape. Keep
      // the raw result too: a failure the server could not normalise has no
      // structuredContent at all, and the text content is then the only clue.
      drift.set(name, [`call failed: ${JSON.stringify(structured.error ?? raw)}`]);
    }
    return structured;
  }
  const parsed = spec.output.safeParse(structured);
  validated.add(name);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 12)
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`);
    // First failure wins: later calls of the same tool add nothing.
    if (!drift.has(name)) drift.set(name, issues);
  }
  return structured;
}

try {
  await harness.waitForInstance();
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: { ...process.env, RACKMCP_RACK_USER_DIR: harness.userDir },
    stderr: "pipe",
  });
  await client.connect(transport);

  // --- discovery, selection, status, leases ------------------------------
  const instances = (await call("list_rack_instances")).instances as Array<Record<string, unknown>>;
  const live = instances.find((i) => !i.stale);
  ok("found a live instance", live !== undefined);
  await call("select_rack_instance", { instanceId: live!.instanceId });
  await call("get_rack_status");
  await call("acquire_writer_lease");

  // Validate the seed patch FIRST, while it is just the harness Bridge module:
  // no audio destination, so the report is non-empty. Validating only the
  // finished fixture would leave `findings[]` empty and never strict-parse a
  // ValidationFinding — the part of this payload most likely to drift.
  const seedReport = (await call("validate_patch")) as { findings: unknown[] };
  ok(
    "validate_patch report carries findings to check",
    Array.isArray(seedReport.findings) && seedReport.findings.length > 0,
    `${seedReport.findings?.length ?? 0} findings`,
  );

  // --- catalog and inspection --------------------------------------------
  await call("list_installed_models", { limit: 5 });
  await call("inspect_model", { pluginSlug: "Fundamental", modelSlug: "VCO" });

  // Build a small patch so the inspection and probe tools have real targets.
  const built = (await call("build_patch", {
    label: "Contract fixture",
    operationId: randomUUID(),
    operations: [
      { op: "add_module", pluginSlug: "Fundamental", modelSlug: "VCO", alias: "vco", placement: "auto" },
      { op: "add_module", pluginSlug: "Core", modelSlug: "AudioInterface2", alias: "audio", placement: "auto" },
      {
        op: "connect",
        output: { module: { alias: "vco" }, portType: "output", portId: 2 },
        input: { module: { alias: "audio" }, portType: "input", portId: 0 },
        inputPolicy: "fail_if_connected",
      },
    ],
  })) as { commit: { aliasToModuleId: Record<string, string> } };
  const vcoId = built.commit.aliasToModuleId.vco;
  ok("fixture patch built", typeof vcoId === "string");

  await call("get_patch_snapshot");
  await call("inspect_module", { moduleId: vcoId });
  await call("inspect_parameter", { moduleId: vcoId, paramId: 2 });
  await call("describe_patch");
  await call("validate_patch");

  // --- transactions -------------------------------------------------------
  const txnOps = [{ op: "set_parameter", module: { moduleId: vcoId }, paramId: 2, value: 0.25 }];
  const preview = (await call("preview_patch_transaction", {
    label: "Tune",
    operations: txnOps,
  })) as { preview: { planHash: string; baseFingerprint: string } };
  const txnOpId = randomUUID();
  await call("commit_patch_transaction", {
    operationId: txnOpId,
    planHash: preview.preview.planHash,
    expectedFingerprint: preview.preview.baseFingerprint,
  });
  await call("undo_last_mcp_transaction", { operationId: txnOpId });

  // --- patch files --------------------------------------------------------
  await call("list_patch_files", { root: "patches" });
  const checkpoint = (await call("create_checkpoint", {
    label: "contract",
    operationId: randomUUID(),
  })) as { checkpointPath: string };
  const savePath = join(harness.userDir, "patches", "contract.vcv");
  await call("save_patch", { path: savePath, operationId: randomUUID() });

  const clearPreview = (await call("preview_clear_patch")) as {
    confirmation: { confirmationToken: string };
  };
  await call("commit_clear_patch", {
    confirmationToken: clearPreview.confirmation.confirmationToken,
    operationId: randomUUID(),
  });
  const loadPreview = (await call("preview_load_patch", { path: savePath })) as {
    confirmation: { confirmationToken: string };
  };
  await call("commit_load_patch", {
    confirmationToken: loadPreview.confirmation.confirmationToken,
    operationId: randomUUID(),
  });
  const restorePreview = (await call("restore_checkpoint", {
    checkpointPath: checkpoint.checkpointPath,
    operationId: randomUUID(),
  })) as { confirmation: { confirmationToken: string } };
  await call("restore_checkpoint", {
    checkpointPath: checkpoint.checkpointPath,
    confirmationToken: restorePreview.confirmation.confirmationToken,
    operationId: randomUUID(),
  });

  // --- probes -------------------------------------------------------------
  // The restore replaced the patch, so re-resolve the VCO by model slug.
  const afterRestore = (await call("get_patch_snapshot")).modules as Array<Record<string, unknown>>;
  const vco = afterRestore.find((m) => m.modelSlug === "VCO");
  ok("VCO present after restore", vco !== undefined);
  await call("list_probes");
  const attachPreview = (await call("preview_attach_probe", {
    source: { module: { moduleId: vco!.moduleId }, portType: "output", portId: 0 },
  })) as {
    preview: { planHash: string; baseFingerprint: string };
    confirmation: { confirmationToken: string };
  };
  const attached = (await call("commit_attach_probe", {
    operationId: randomUUID(),
    planHash: attachPreview.preview.planHash,
    expectedFingerprint: attachPreview.preview.baseFingerprint,
    confirmationToken: attachPreview.confirmation.confirmationToken,
  })) as { probeModuleId: string; probeInputId: number };
  await call("read_probe", {
    probeModuleId: attached.probeModuleId,
    probeInputId: attached.probeInputId,
  });
  const epoch = (await call("get_rack_status")).status as { patchEpoch: number };
  await call("detach_probe", {
    probeModuleId: attached.probeModuleId,
    probeInputId: attached.probeInputId,
    operationId: randomUUID(),
    expectedPatchEpoch: epoch.patchEpoch,
  });

  await call("release_writer_lease");

  // --- verdict ------------------------------------------------------------
  const unexercised = TOOLS.filter((t) => !validated.has(t.name)).map((t) => t.name);
  ok(
    `every registered tool validated (${validated.size}/${TOOLS.length})`,
    unexercised.length === 0,
    unexercised.join(", "),
  );
  for (const t of TOOLS) {
    const issues = drift.get(t.name);
    ok(`${t.name} output matches its schema`, issues === undefined, issues?.join(" | ") ?? "");
  }

  await client.close();
} catch (e) {
  console.error("CONTRACT SMOKE FAILURE:", e);
  console.error("Rack log tail:\n" + harness.logTail());
  failures++;
} finally {
  try {
    await client.close();
  } catch {
    /* already closed */
  }
  await harness.quit();
}
console.error(failures ? `CONTRACT SMOKE: FAILED (${failures})` : "CONTRACT SMOKE: PASSED");
process.exitCode = failures ? 1 : 0;
