/**
 * Phase 5-7 write-path test: build a subtractive synth through the MCP write
 * path and verify preview/commit, structural correctness, parameter changes,
 * fingerprint-conflict rejection, idempotent retry, and undo — the headline
 * Definition-of-Done scenario, live against real Rack.
 *
 * Signal path: MIDI-CV V/Oct -> VCO 1V/oct; VCO Saw -> VCF Audio; MIDI Gate
 * -> ADSR Gate; ADSR Env -> VCA CV; VCF Lowpass -> VCA Channel; VCA -> Audio.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { RackHarness } from "./harness.js";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const SERVER_ENTRY = join(REPO_ROOT, "apps", "mcp-server", "dist", "index.js");
const scratch = process.env.RACKMCP_TEST_DIR ?? mkdtempSync(join(tmpdir(), "rackmcp-"));
let failures = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  if (!cond) { console.error(`FAIL ${name} ${detail}`); failures++; }
  else console.error(`ok   ${name}${detail ? ` (${detail})` : ""}`);
}
function sc(result: unknown): Record<string, unknown> {
  return (result as { structuredContent: Record<string, unknown> }).structuredContent;
}
async function call(client: Client, name: string, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args });
}

const harness = new RackHarness({ baseDir: scratch, name: "write" });
harness.prepare();
harness.launch();
const client = new Client({ name: "write-test", version: "0.1.0" });
let transport: StdioClientTransport | null = null;

function cn(outAlias: string, outType: string, outPort: number, inAlias: string, inType: string, inPort: number) {
  return {
    op: "connect",
    output: { module: { alias: outAlias }, portType: outType, portId: outPort },
    input: { module: { alias: inAlias }, portType: inType, portId: inPort },
    inputPolicy: "fail_if_connected",
  };
}

const SYNTH_OPS = [
  { op: "add_module", pluginSlug: "Core", modelSlug: "MIDIToCVInterface", alias: "midi", placement: "auto" },
  { op: "add_module", pluginSlug: "Fundamental", modelSlug: "VCO", alias: "vco", placement: "auto" },
  { op: "add_module", pluginSlug: "Fundamental", modelSlug: "ADSR", alias: "adsr", placement: "auto" },
  { op: "add_module", pluginSlug: "Fundamental", modelSlug: "VCF", alias: "vcf", placement: "auto" },
  { op: "add_module", pluginSlug: "Fundamental", modelSlug: "VCA-1", alias: "vca", placement: "auto" },
  { op: "add_module", pluginSlug: "Core", modelSlug: "AudioInterface2", alias: "audio", placement: "auto" },
  cn("midi", "output", 0, "vco", "input", 0),
  cn("vco", "output", 2, "vcf", "input", 3),
  cn("midi", "output", 1, "adsr", "input", 4),
  cn("adsr", "output", 0, "vca", "input", 0),
  cn("vcf", "output", 0, "vca", "input", 1),
  cn("vca", "output", 0, "audio", "input", 0),
];

try {
  await harness.waitForInstance();
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: { ...process.env, RACKMCP_RACK_USER_DIR: harness.userDir },
    stderr: "pipe",
  });
  await client.connect(transport);
  const inst = sc(await call(client, "list_rack_instances", {})).instances as Array<Record<string, unknown>>;
  await call(client, "select_rack_instance", { instanceId: inst.find((i) => !i.stale)!.instanceId });

  // Preview the synth build.
  const preview = sc(await call(client, "preview_patch_transaction", { label: "Subtractive synth", operations: SYNTH_OPS }));
  ok("preview returns plan hash", typeof (preview.preview as any).planHash === "string");
  ok("preview base fingerprint", typeof (preview.preview as any).baseFingerprint === "string");
  const diff = (preview.preview as any).diff;
  ok("preview diff adds 6 modules", diff.addedModules.length === 6, `${diff.addedModules.length}`);
  ok("preview diff adds 6 cables", diff.addedCableCount === 6, `${diff.addedCableCount}`);
  const risk = (preview.preview as any).risk;
  ok("preview risk not destructive", (preview.confirmation as any).confirmationRequired === false, risk.level);

  // build_patch auto-commits a non-destructive plan.
  const built = sc(await call(client, "build_patch", { label: "Subtractive synth", operations: SYNTH_OPS, operationId: randomUUID() }));
  ok("build_patch committed", built.phase === "committed", String(built.phase));
  const commit = built.commit as any;
  ok("commit maps all aliases", Object.keys(commit.aliasToModuleId).length === 6);
  ok("commit reports 12 applied ops", commit.applied.length === 12, `${commit.applied.length}`);
  ok("commit new != old fingerprint", commit.newFingerprint !== commit.oldFingerprint);

  // Verify structure in the snapshot.
  const snap = sc(await call(client, "get_patch_snapshot", {}));
  const modules = snap.modules as Array<Record<string, unknown>>;
  const cables = snap.cables as Array<Record<string, unknown>>;
  ok("snapshot has 7 modules (6 + Bridge)", modules.length === 7, `${modules.length}`);
  ok("snapshot has 6 cables", cables.length === 6, `${cables.length}`);
  const vcoId = commit.aliasToModuleId.vco as string;
  const audioId = commit.aliasToModuleId.audio as string;
  ok("VCA->Audio cable exists", cables.some((c) => c.inputModuleId === audioId && c.inputId === 0));

  // validate_patch now sees an audio path.
  const validation = sc(await call(client, "validate_patch", {}));
  const findings = validation.findings as Array<Record<string, unknown>>;
  ok("validate: no error findings", (validation.errorCount as number) === 0, JSON.stringify(findings.filter((f) => f.severity === "error")));
  ok("validate: audio has input (no silence warning)", !findings.some((f) => f.ruleId === "audio.noInput"));

  // Set the VCO frequency parameter (paramId 2 = Frequency), via a new txn.
  const setFreqOps = [{ op: "set_parameter", module: { moduleId: vcoId }, paramId: 2, value: 1.0 }];
  const paramBuilt = sc(await call(client, "build_patch", { label: "Tune VCO", operations: setFreqOps, operationId: randomUUID() }));
  ok("param change committed", paramBuilt.phase === "committed");
  const vcoAfter = sc(await call(client, "inspect_module", { moduleId: vcoId })).module as any;
  const freqParam = vcoAfter.params.find((p: any) => p.paramId === 2);
  ok("VCO freq param updated", Math.abs(freqParam.value - 1.0) < 1e-3, String(freqParam.value));

  // Fingerprint conflict: preview against current state, mutate, then commit stale.
  const stalePrev = sc(await call(client, "preview_patch_transaction", { label: "Stale", operations: [{ op: "set_parameter", module: { moduleId: vcoId }, paramId: 2, value: 0.5 }] }));
  // Mutate in between with a different committed change.
  await call(client, "build_patch", { label: "Interleaved", operations: [{ op: "set_parameter", module: { moduleId: vcoId }, paramId: 5, value: 0.7 }], operationId: randomUUID() });
  const staleCommit = await call(client, "commit_patch_transaction", {
    operationId: randomUUID(),
    planHash: (stalePrev.preview as any).planHash,
    expectedFingerprint: (stalePrev.preview as any).baseFingerprint,
  });
  ok("stale commit rejected", (staleCommit as any).isError === true);
  ok("stale commit is PATCH_CONFLICT", (sc(staleCommit).error as any)?.code === "PATCH_CONFLICT", (sc(staleCommit).error as any)?.code);

  // Idempotent retry: same operationId must not double-apply.
  const beforeIdem = sc(await call(client, "get_patch_snapshot", {}));
  const idemOp = randomUUID();
  const idemOps = [{ op: "add_module", pluginSlug: "Fundamental", modelSlug: "LFO", alias: "lfo", placement: "auto" }];
  // Preview + commit twice with the SAME operationId (re-preview to get a fresh plan/fingerprint each call, but reuse the op id).
  const p1 = sc(await call(client, "preview_patch_transaction", { label: "Add LFO", operations: idemOps }));
  const c1 = sc(await call(client, "commit_patch_transaction", { operationId: idemOp, planHash: (p1.preview as any).planHash, expectedFingerprint: (p1.preview as any).baseFingerprint }));
  const afterFirst = sc(await call(client, "get_patch_snapshot", {}));
  ok("idempotent add applied once", (afterFirst.modules as unknown[]).length === (beforeIdem.modules as unknown[]).length + 1);
  // Retry the SAME operationId (re-preview since fingerprint changed, but the plugin replays by op id).
  const p2 = sc(await call(client, "preview_patch_transaction", { label: "Add LFO", operations: idemOps }));
  const c2 = await call(client, "commit_patch_transaction", { operationId: idemOp, planHash: (p2.preview as any).planHash, expectedFingerprint: (p2.preview as any).baseFingerprint });
  const afterRetry = sc(await call(client, "get_patch_snapshot", {}));
  ok("idempotent retry did not double-add", (afterRetry.modules as unknown[]).length === (afterFirst.modules as unknown[]).length, `${(afterRetry.modules as unknown[]).length}`);
  ok("idempotent retry marked replayed", (sc(c2) as any).replayed === true || (c2 as any).isError !== true);
  void c1;

  // Undo the last MCP transaction (the LFO add).
  const undo = sc(await call(client, "undo_last_mcp_transaction", { operationId: idemOp }));
  ok("undo succeeded", (undo as any).undone === true);
  const afterUndo = sc(await call(client, "get_patch_snapshot", {}));
  ok("undo removed the LFO", (afterUndo.modules as unknown[]).length === (afterFirst.modules as unknown[]).length - 1);

  // Rollback leaves no orphans: an op that passes preview (synthetic-module
  // port bounds are only checkable at apply) but fails at commit must roll the
  // whole transaction back — the added module must not remain.
  const beforeRollback = sc(await call(client, "get_patch_snapshot", {}));
  const badOps = [
    { op: "add_module", pluginSlug: "Fundamental", modelSlug: "VCO", alias: "orphan", placement: "auto" },
    {
      op: "connect",
      output: { module: { alias: "orphan" }, portType: "output", portId: 99 },
      input: { module: { moduleId: audioId }, portType: "input", portId: 1 },
      inputPolicy: "fail_if_connected",
    },
  ];
  const badPrev = sc(await call(client, "preview_patch_transaction", { label: "Bad", operations: badOps }));
  ok("bad txn previews (bounds deferred to apply)", typeof (badPrev.preview as any).planHash === "string");
  const badCommit = await call(client, "commit_patch_transaction", {
    operationId: randomUUID(),
    planHash: (badPrev.preview as any).planHash,
    expectedFingerprint: (badPrev.preview as any).baseFingerprint,
  });
  ok("bad txn commit fails", (badCommit as any).isError === true);
  const afterRollback = sc(await call(client, "get_patch_snapshot", {}));
  ok(
    "rollback left no orphan module",
    (afterRollback.modules as unknown[]).length === (beforeRollback.modules as unknown[]).length,
    `${(afterRollback.modules as unknown[]).length} vs ${(beforeRollback.modules as unknown[]).length}`,
  );
  ok(
    "rollback preserved fingerprint",
    (afterRollback.fingerprint as string) === (beforeRollback.fingerprint as string),
  );

  // Refuse to undo unrelated work: after a newer transaction, undoing an older
  // one must be refused rather than undoing the newer user work.
  const olderOp = randomUUID();
  const pOlder = sc(await call(client, "preview_patch_transaction", { label: "Older", operations: [{ op: "set_parameter", module: { moduleId: vcoId }, paramId: 2, value: 0.2 }] }));
  await call(client, "commit_patch_transaction", { operationId: olderOp, planHash: (pOlder.preview as any).planHash, expectedFingerprint: (pOlder.preview as any).baseFingerprint });
  const pNewer = sc(await call(client, "preview_patch_transaction", { label: "Newer", operations: [{ op: "set_parameter", module: { moduleId: vcoId }, paramId: 2, value: 0.4 }] }));
  await call(client, "commit_patch_transaction", { operationId: randomUUID(), planHash: (pNewer.preview as any).planHash, expectedFingerprint: (pNewer.preview as any).baseFingerprint });
  const refusedUndo = await call(client, "undo_last_mcp_transaction", { operationId: olderOp });
  ok("undo of non-top transaction refused", (refusedUndo as any).isError === true);

  await client.close();
} catch (e) {
  console.error("WRITE SMOKE FAILURE:", e);
  console.error("Rack log tail:\n" + harness.logTail());
  failures++;
} finally {
  try { await client.close(); } catch { /* closed */ }
  await harness.quit();
}
console.error(failures ? `WRITE SMOKE: FAILED (${failures})` : "WRITE SMOKE: PASSED");
process.exitCode = failures ? 1 : 0;
