/**
 * Phase 8 live test: save/checkpoint/load/clear/restore against real Rack.
 * Completes the "saved, reloaded" half of the subtractive-synth DoD scenario,
 * plus recovery checkpoints, Bridge reinsertion, epoch increments, and path
 * policy enforcement.
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
function sc(r: unknown): Record<string, unknown> {
  return (r as { structuredContent: Record<string, unknown> }).structuredContent;
}
const call = (client: Client, name: string, args: Record<string, unknown>) =>
  client.callTool({ name, arguments: args });

const harness = new RackHarness({ baseDir: scratch, name: "files" });
harness.prepare();
harness.launch();
const client = new Client({ name: "files-test", version: "0.1.0" });
let transport: StdioClientTransport | null = null;

try {
  await harness.waitForInstance();
  transport = new StdioClientTransport({
    command: process.execPath, args: [SERVER_ENTRY],
    env: { ...process.env, RACKMCP_RACK_USER_DIR: harness.userDir }, stderr: "pipe",
  });
  await client.connect(transport);
  const inst = sc(await call(client, "list_rack_instances", {})).instances as Array<Record<string, unknown>>;
  await call(client, "select_rack_instance", { instanceId: inst.find((i) => !i.stale)!.instanceId });

  // Build a couple of modules so the patch is non-trivial.
  const buildOps = [
    { op: "add_module", pluginSlug: "Fundamental", modelSlug: "VCO", alias: "vco", placement: "auto" },
    { op: "add_module", pluginSlug: "Fundamental", modelSlug: "VCF", alias: "vcf", placement: "auto" },
  ];
  await call(client, "build_patch", { label: "Two modules", operations: buildOps, operationId: randomUUID() });
  const before = sc(await call(client, "get_patch_snapshot", {}));
  const beforeCount = (before.modules as unknown[]).length;
  ok("built patch (3 modules incl Bridge)", beforeCount === 3, `${beforeCount}`);

  // Save into the patches root.
  const savePath = join(harness.userDir, "patches", "roundtrip.vcv");
  const saved = sc(await call(client, "save_patch", { path: savePath, operationId: randomUUID() }));
  ok("save_patch succeeded", saved.saved === true);
  ok("save reports Bridge present", saved.bridgeModulePresent === true);

  // It shows up in list_patch_files.
  const listed = sc(await call(client, "list_patch_files", { root: "patches" }));
  ok("list_patch_files finds the save", (listed.files as Array<Record<string, unknown>>).some((f) => f.name === "roundtrip.vcv"));

  // Create an explicit checkpoint.
  const checkpoint = sc(await call(client, "create_checkpoint", { label: "manual", operationId: randomUUID() }));
  ok("checkpoint created", typeof checkpoint.checkpointPath === "string" && (checkpoint.checkpointPath as string).endsWith(".vcv"));

  // Path policy: outside roots and non-.vcv are rejected.
  const badPath = await call(client, "save_patch", { path: "/etc/passwd", operationId: randomUUID() });
  ok("save outside roots rejected", (badPath as any).isError === true && (sc(badPath).error as any)?.code === "PATH_NOT_ALLOWED");
  const badExt = await call(client, "save_patch", { path: join(harness.userDir, "patches", "x.txt"), operationId: randomUUID() });
  ok("non-.vcv rejected", (sc(badExt).error as any)?.code === "PATH_NOT_ALLOWED");
  const badPreview = await call(client, "preview_load_patch", { path: "https://evil.example/patch.vcv" });
  ok("URL path rejected", (sc(badPreview).error as any)?.code === "PATH_NOT_ALLOWED");

  // Clear the patch (preview -> commit), then confirm epoch bumped + Bridge reinserted.
  const clearPrev = sc(await call(client, "preview_clear_patch", {}));
  ok("clear preview requires confirmation", (clearPrev.confirmation as any).confirmationRequired === true);
  ok("clear preview plans recovery checkpoint", (clearPrev.preview as any).willCreateRecoveryCheckpoint === true);
  const cleared = sc(await call(client, "commit_clear_patch", {
    confirmationToken: (clearPrev.confirmation as any).confirmationToken,
    operationId: randomUUID(),
  }));
  ok("clear made a recovery checkpoint", typeof cleared.recoveryCheckpointPath === "string");
  ok("clear reinserted a Bridge", cleared.bridgeModulePresent === true);
  ok("clear bumped the epoch", (cleared.patchEpoch as number) >= 2, `${cleared.patchEpoch}`);
  const afterClear = sc(await call(client, "get_patch_snapshot", {}));
  ok("after clear only Bridge remains", (afterClear.modules as unknown[]).length === 1, `${(afterClear.modules as unknown[]).length}`);

  // Reload the saved patch (preview -> commit) and verify the round trip.
  const loadPrev = sc(await call(client, "preview_load_patch", { path: savePath }));
  ok("load preview exists", (loadPrev.preview as any).exists === true);
  const loaded = sc(await call(client, "commit_load_patch", {
    confirmationToken: (loadPrev.confirmation as any).confirmationToken,
    operationId: randomUUID(),
  }));
  ok("load made a recovery checkpoint", typeof loaded.recoveryCheckpointPath === "string");
  ok("load bumped the epoch", (loaded.patchEpoch as number) >= 3, `${loaded.patchEpoch}`);
  const afterLoad = sc(await call(client, "get_patch_snapshot", {}));
  ok("reloaded patch restores module count", (afterLoad.modules as unknown[]).length === beforeCount, `${(afterLoad.modules as unknown[]).length}`);
  const models = (afterLoad.modules as Array<Record<string, unknown>>).map((m) => m.modelSlug).sort();
  ok("reloaded patch has VCO and VCF", models.includes("VCO") && models.includes("VCF"), JSON.stringify(models));

  // Restore a checkpoint (preview then commit).
  const restorePrev = sc(await call(client, "restore_checkpoint", { checkpointPath: checkpoint.checkpointPath, operationId: randomUUID() }));
  ok("restore preview phase", restorePrev.phase === "preview");
  const restoredRaw = await call(client, "restore_checkpoint", {
    checkpointPath: checkpoint.checkpointPath,
    confirmationToken: (restorePrev.confirmation as any).confirmationToken,
    operationId: randomUUID(),
  });

  const restored = sc(restoredRaw);
  ok("restore committed", restored.phase === "restored");
  const afterRestore = sc(await call(client, "get_patch_snapshot", {}));
  ok("restore brought modules back", (afterRestore.modules as unknown[]).length === beforeCount, `${(afterRestore.modules as unknown[]).length}`);

  await client.close();
} catch (e) {
  console.error("FILES SMOKE FAILURE:", e);
  console.error("Rack log tail:\n" + harness.logTail());
  failures++;
} finally {
  try { await client.close(); } catch { /* closed */ }
  await harness.quit();
}
console.error(failures ? `FILES SMOKE: FAILED (${failures})` : "FILES SMOKE: PASSED");
process.exitCode = failures ? 1 : 0;
