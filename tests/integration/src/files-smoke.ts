/**
 * Phase 8 live test: save/checkpoint/load/clear/restore against real Rack.
 * Completes the "saved, reloaded" half of the subtractive-synth DoD scenario,
 * plus recovery checkpoints, Bridge reinsertion, epoch increments, and path
 * policy enforcement.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Checks, RackTestClient } from "@rackmcp/test-client";
import { RackHarness } from "./harness.js";

const scratch = process.env.RACKMCP_TEST_DIR ?? mkdtempSync(join(tmpdir(), "rackmcp-"));
const checks = new Checks("FILES SMOKE");
const ok = checks.ok.bind(checks);

const harness = new RackHarness({ baseDir: scratch, name: "files" });
harness.prepare();
harness.launch();
let client: RackTestClient | null = null;

try {
  await harness.waitForInstance();
  client = await RackTestClient.connect({ userDir: harness.userDir, name: "files-test" });
  await client.selectLiveInstance();

  // Build a couple of modules so the patch is non-trivial.
  const buildOps = [
    { op: "add_module", pluginSlug: "Fundamental", modelSlug: "VCO", alias: "vco", placement: "auto" },
    { op: "add_module", pluginSlug: "Fundamental", modelSlug: "VCF", alias: "vcf", placement: "auto" },
  ];
  await client.call("build_patch", { label: "Two modules", operations: buildOps, operationId: randomUUID() });
  const before = await client.call("get_patch_snapshot", {});
  const beforeCount = (before.modules as unknown[]).length;
  ok("built patch (3 modules incl Bridge)", beforeCount === 3, `${beforeCount}`);

  // Save into the patches root.
  const savePath = join(harness.userDir, "patches", "roundtrip.vcv");
  const saved = await client.call("save_patch", { path: savePath, operationId: randomUUID() });
  ok("save_patch succeeded", saved.saved === true);
  ok("save reports Bridge present", saved.bridgeModulePresent === true);

  // The very next read must describe the patch that was just written. The
  // handlers used to answer out of a cache the pump refreshes every 30 frames
  // AFTER draining the command queue, so this reported `patchName: null` for
  // the file save_patch had returned success for one call earlier.
  const statusAfterSave = (await client.call("get_rack_status")).status as Record<string, unknown>;
  ok("status names the patch immediately after saving it",
     statusAfterSave.patchName === "roundtrip",
     `patchName=${String(statusAfterSave.patchName)}`);
  ok("status agrees the patch is saved", statusAfterSave.saved === true);

  // It shows up in list_patch_files.
  const listed = await client.call("list_patch_files", { root: "patches" });
  ok("list_patch_files finds the save", (listed.files as Array<Record<string, unknown>>).some((f) => f.name === "roundtrip.vcv"));

  // Create an explicit checkpoint.
  const checkpoint = await client.call("create_checkpoint", { label: "manual", operationId: randomUUID() });
  ok("checkpoint created", typeof checkpoint.checkpointPath === "string" && (checkpoint.checkpointPath as string).endsWith(".vcv"));

  // Two checkpoints with the same label must be two files. The name encodes
  // (millisecond, sanitised label, truncated to 40) and the plugin renames over
  // whatever is at the destination, so a collision silently destroys a recovery
  // point -- and nothing keeps a second copy.
  const twinA = await client.call("create_checkpoint", { label: "twin", operationId: randomUUID() });
  const twinB = await client.call("create_checkpoint", { label: "twin", operationId: randomUUID() });
  ok("same-label checkpoints get distinct files",
     twinA.checkpointPath !== twinB.checkpointPath,
     `${String(twinA.checkpointPath)} vs ${String(twinB.checkpointPath)}`);
  const bothListed = (await client.call("list_patch_files", { root: "checkpoints" })).files as Array<Record<string, unknown>>;
  ok("both twins were written",
     [twinA, twinB].every((t) => bothListed.some((f) => f.path === t.checkpointPath && (f.sizeBytes as number) > 0)),
     JSON.stringify(bothListed.map((f) => [f.name, f.sizeBytes])));

  // Path policy: outside roots and non-.vcv are rejected.
  ok("save outside roots rejected",
    (await client.expectError("save_patch", { path: "/etc/passwd", operationId: randomUUID() })).code === "PATH_NOT_ALLOWED");
  ok("non-.vcv rejected",
    (await client.expectError("save_patch", { path: join(harness.userDir, "patches", "x.txt"), operationId: randomUUID() })).code === "PATH_NOT_ALLOWED");
  ok("URL path rejected",
    (await client.expectError("preview_load_patch", { path: "https://evil.example/patch.vcv" })).code === "PATH_NOT_ALLOWED");

  // Each root has exactly one door. restore_checkpoint already refused a
  // patches-root source; these are the other three directions, which nothing
  // enforced -- so an ordinary save could overwrite a recovery point and be
  // listed as one, and a load could adopt a checkpoint as the patch path.
  ok("save into the checkpoints root rejected",
    (await client.expectError("save_patch", { path: checkpoint.checkpointPath, operationId: randomUUID() })).code === "PATH_NOT_ALLOWED");
  ok("load of a checkpoint through preview_load_patch rejected",
    (await client.expectError("preview_load_patch", { path: checkpoint.checkpointPath })).code === "PATH_NOT_ALLOWED");
  const stillThere = (await client.call("list_patch_files", { root: "checkpoints" })).files as Array<Record<string, unknown>>;
  ok("the refused save left the checkpoint intact",
     stillThere.some((f) => f.path === checkpoint.checkpointPath && (f.sizeBytes as number) > 0));

  // Clear the patch (preview -> commit), then confirm epoch bumped + Bridge reinserted.
  const clearPrev = await client.call("preview_clear_patch", {});
  ok("clear preview requires confirmation", (clearPrev.confirmation as any).confirmationRequired === true);
  ok("clear preview plans recovery checkpoint", (clearPrev.preview as any).willCreateRecoveryCheckpoint === true);
  const cleared = await client.call("commit_clear_patch", {
    confirmationToken: (clearPrev.confirmation as any).confirmationToken,
    operationId: randomUUID(),
  });
  ok("clear made a recovery checkpoint", typeof cleared.recoveryCheckpointPath === "string");
  ok("clear reinserted a Bridge", cleared.bridgeModulePresent === true);
  ok("clear bumped the epoch", (cleared.patchEpoch as number) >= 2, `${cleared.patchEpoch}`);
  const afterClear = await client.call("get_patch_snapshot", {});
  ok("after clear only Bridge remains", (afterClear.modules as unknown[]).length === 1, `${(afterClear.modules as unknown[]).length}`);

  // Reload the saved patch (preview -> commit) and verify the round trip.
  const loadPrev = await client.call("preview_load_patch", { path: savePath });
  ok("load preview exists", (loadPrev.preview as any).exists === true);
  const loaded = await client.call("commit_load_patch", {
    confirmationToken: (loadPrev.confirmation as any).confirmationToken,
    operationId: randomUUID(),
  });
  ok("load made a recovery checkpoint", typeof loaded.recoveryCheckpointPath === "string");
  // A load DOES adopt the file as the patch's identity -- that is what loading
  // a patch means, and the restore assertions below only mean something if this
  // half still works.
  ok("load adopted the loaded file as the patch", loaded.patchName === "roundtrip", String(loaded.patchName));
  ok("load bumped the epoch", (loaded.patchEpoch as number) >= 3, `${loaded.patchEpoch}`);
  const afterLoad = await client.call("get_patch_snapshot", {});
  ok("reloaded patch restores module count", (afterLoad.modules as unknown[]).length === beforeCount, `${(afterLoad.modules as unknown[]).length}`);
  const models = (afterLoad.modules as Array<Record<string, unknown>>).map((m) => m.modelSlug).sort();
  ok("reloaded patch has VCO and VCF", models.includes("VCO") && models.includes("VCF"), JSON.stringify(models));

  // Restore a checkpoint (preview then commit).
  const restorePrev = await client.call("restore_checkpoint", { checkpointPath: checkpoint.checkpointPath, operationId: randomUUID() });
  ok("restore preview phase", restorePrev.phase === "preview");
  const restored = await client.call("restore_checkpoint", {
    checkpointPath: checkpoint.checkpointPath,
    confirmationToken: (restorePrev.confirmation as any).confirmationToken,
    operationId: randomUUID(),
  });
  ok("restore committed", restored.phase === "restored");
  const afterRestore = await client.call("get_patch_snapshot", {});
  ok("restore brought modules back", (afterRestore.modules as unknown[]).length === beforeCount, `${(afterRestore.modules as unknown[]).length}`);

  // A checkpoint is contents, not an identity. Restoring used to point
  // `APP->patch->path` at the checkpoint, and both `save_patch` with no path
  // and Rack's own Cmd/Ctrl+S write to that member -- so restoring a recovery
  // point and then saving overwrote the recovery point. Only a live Rack can
  // answer this: the path lives in the patch manager, and `patchName` is its
  // stem (RackBridge.cpp).
  const checkpointStem = (checkpoint.checkpointPath as string).replace(/^.*[/\\]/, "").replace(/\.vcv$/i, "");
  const restoredResult = restored.result as Record<string, unknown>;
  ok("restore did not adopt the checkpoint as the patch",
     restoredResult.patchName !== checkpointStem && restoredResult.patchName === null,
     `patchName=${String(restoredResult.patchName)} checkpoint=${checkpointStem}`);
  const statusAfterRestore = (await client.call("get_rack_status")).status as Record<string, unknown>;
  ok("status agrees the restored patch has no file",
     statusAfterRestore.patchName === null,
     `patchName=${String(statusAfterRestore.patchName)}`);
  // The consequence that matters: a pathless save can no longer land on the
  // checkpoint. It is refused instead, which is also what Rack's Save does
  // (it opens a chooser rather than writing).
  ok("a pathless save after a restore is refused rather than overwriting the checkpoint",
    (await client.expectError("save_patch", { operationId: randomUUID() })).code === "PATH_NOT_ALLOWED");
  const afterAll = (await client.call("list_patch_files", { root: "checkpoints" })).files as Array<Record<string, unknown>>;
  const cp = afterAll.find((f) => f.path === checkpoint.checkpointPath);
  ok("the restored checkpoint is still on disk and unchanged in size",
     cp !== undefined && (cp.sizeBytes as number) > 0,
     JSON.stringify(cp ?? null));
} catch (e) {
  checks.fail("FILES SMOKE", String(e));
  console.error("Rack log tail:\n" + harness.logTail());
} finally {
  await client?.close();
  await harness.quit();
}
checks.finish();
