import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { platform } from "node:os";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ServerConfig } from "../src/config.js";
import type { ConnectionManager, SelectedInstance } from "../src/connection.js";
import { ToolError } from "../src/errors.js";
import { TransactionManager } from "../src/transactions.js";
import { releaseCheckpointReservation, reserveCheckpointPath } from "../src/paths.js";
import {
  bindServerConfig,
  commitClearPatch,
  listPatchFiles,
  commitLoadPatch,
  createCheckpoint,
  previewClearPatch,
  previewLoadPatch,
  restoreCheckpoint,
  savePatch,
} from "../src/patchfiles.js";
import { SavePatchOutput } from "@rackmcp/schemas";
import { expectDeclaredRequests, expectNoStaleDivergences } from "./support/wire.js";
import type { ToolContext } from "../src/tools.js";

/**
 * Load/clear/restore confirmation and recovery-checkpoint behaviour (spec
 * section 8). The plugin is faked; what is under test is the server's own
 * ordering: bind the previewed state, refuse to destroy without a recovery
 * checkpoint, burn the token, then load or clear.
 */

const INSTANCE: SelectedInstance = {
  instanceId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  rackVersion: "2.6.6",
  rackEdition: "Free",
  port: 4000,
  pid: 42,
};

const FP_A = "a".repeat(64);
const FP_B = "b".repeat(64);

/** Plugin stand-in: records every bridge call and answers from mutable state. */
class FakeBridge {
  calls: { method: string; payload: Record<string, unknown> }[] = [];
  instance: SelectedInstance = { ...INSTANCE };
  saved = false;
  fingerprint = FP_A;
  patchEpoch = 5;
  saveCopyError: unknown = null;
  /** Where the plugin says the patch ended up; "" reproduces the old bug. */
  resolvedPath = "/patches/current.vcv";

  async ensureConnected(): Promise<SelectedInstance> {
    return this.instance;
  }
  async ensureLease(): Promise<void> {}

  async request(method: string, payload: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, payload });
    switch (method) {
      case "status.get":
        return { saved: this.saved, patchEpoch: this.patchEpoch };
      case "patch.fingerprint":
        return { fingerprint: this.fingerprint, patchEpoch: this.patchEpoch };
      case "patchfile.saveCopy":
        if (this.saveCopyError) throw this.saveCopyError;
        return this.fileResult();
      case "patchfile.save":
      case "patchfile.load":
      case "patchfile.clear":
        return this.fileResult();
      default:
        throw new Error(`unexpected bridge method ${method}`);
    }
  }

  private fileResult() {
    return {
      fingerprint: this.fingerprint,
      patchEpoch: this.patchEpoch,
      patchName: null,
      path: this.resolvedPath,
      saved: true,
      bridgeModulePresent: true,
      warnings: [],
      replayed: false,
    };
  }

  methods(): string[] {
    return this.calls.map((c) => c.method);
  }
  payloadsFor(method: string): Record<string, unknown>[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.payload);
  }
}

interface PreviewResult {
  preview: { willInsertBridgeModule: boolean; warnings: string[] };
  confirmation: { confirmationToken: string };
}
interface RestoreResult {
  phase: string;
  confirmation?: { confirmationToken: string };
  result?: { recoveryCheckpointPath: string | null };
}

let dir: string;
let cfg: ServerConfig;
let bridge: FakeBridge;
let ctx: ToolContext;

function configFor(root: string): ServerConfig {
  return {
    rackUserDir: root,
    rackmcpDir: join(root, "RackMCP"),
    discoveryDir: join(root, "RackMCP", "instances"),
    checkpointsDir: join(root, "RackMCP", "checkpoints"),
    patchesDir: join(root, "patches"),
    auditDir: join(root, "RackMCP", "audit"),
    requestDeadlineMs: 5000,
  };
}

beforeEach(() => {
  // realpath the temp dir: on macOS /var is itself a symlink to /private/var.
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "rackmcp-patchfiles-")));
  cfg = configFor(join(dir, "rack"));
  mkdirSync(cfg.patchesDir, { recursive: true });
  mkdirSync(cfg.checkpointsDir, { recursive: true });
  writeFileSync(join(cfg.patchesDir, "song.vcv"), "patch");
  writeFileSync(join(cfg.checkpointsDir, "cp-a.vcv"), "checkpoint a");
  writeFileSync(join(cfg.checkpointsDir, "cp-b.vcv"), "checkpoint b");
  bridge = new FakeBridge();
  ctx = {
    conn: bridge as unknown as ConnectionManager,
    txns: new TransactionManager(bridge as unknown as ConnectionManager),
    serverVersion: "test",
    bridgeProtocolVersion: 1,
  };
  bindServerConfig(ctx, cfg);
});

afterEach(() => {
  // Free coverage: FakeBridge already receives every payload the handlers
  // build, and nothing else in the repo checks an outbound frame.
  expectDeclaredRequests(bridge.calls);
  // Here rather than at the end of each test body: a failing assertion throws
  // past a trailing restore, and a leaked `Date.now` mock would then decide the
  // outcome of every test after it.
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

// This file exercises every excused path, so it owns the staleness check.
afterAll(expectNoStaleDivergences);

async function loadToken(name = "song.vcv"): Promise<string> {
  const res = (await previewLoadPatch({ path: join(cfg.patchesDir, name) }, ctx)) as PreviewResult;
  return res.confirmation.confirmationToken;
}

async function restoreToken(name: string): Promise<string> {
  const res = (await restoreCheckpoint(
    { checkpointPath: join(cfg.checkpointsDir, name), operationId: randomUUID() },
    ctx,
  )) as RestoreResult;
  expect(res.phase).toBe("preview");
  return res.confirmation!.confirmationToken;
}

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ToolError);
    expect((e as ToolError).code).toBe(code);
    return;
  }
  throw new Error(`expected a ToolError(${code})`);
}

describe("load/clear preview disclosure", () => {
  it("discloses the Bridge insertion for a load, not only for a clear", async () => {
    const res = (await previewLoadPatch(
      { path: join(cfg.patchesDir, "song.vcv") },
      ctx,
    )) as PreviewResult;
    expect(res.preview.willInsertBridgeModule).toBe(true);
    expect(res.preview.warnings.some((w) => /RackMCP-Bridge/.test(w))).toBe(true);
  });

  it("still discloses it for a clear", async () => {
    const res = (await previewClearPatch({}, ctx)) as PreviewResult;
    expect(res.preview.willInsertBridgeModule).toBe(true);
  });
});

describe("commit_load_patch", () => {
  it("checkpoints, then loads the path bound by the token", async () => {
    const token = await loadToken();
    const res = (await commitLoadPatch(
      { confirmationToken: token, operationId: randomUUID() },
      ctx,
    )) as { recoveryCheckpointPath: string | null };
    expect(bridge.methods()).toContain("patchfile.saveCopy");
    expect(bridge.methods().indexOf("patchfile.saveCopy")).toBeLessThan(
      bridge.methods().indexOf("patchfile.load"),
    );
    expect(bridge.payloadsFor("patchfile.load")[0]!.path).toBe(join(cfg.patchesDir, "song.vcv"));
    expect(res.recoveryCheckpointPath).toContain(cfg.checkpointsDir);
  });

  it("burns the token: a second commit with it is refused before any mutation", async () => {
    const token = await loadToken();
    await commitLoadPatch({ confirmationToken: token, operationId: randomUUID() }, ctx);
    bridge.calls.length = 0;
    await expectCode(
      commitLoadPatch({ confirmationToken: token, operationId: randomUUID() }, ctx),
      "CONFIRMATION_EXPIRED",
    );
    expect(bridge.methods()).not.toContain("patchfile.load");
    expect(bridge.methods()).not.toContain("patchfile.saveCopy");
  });

  it("refuses when the patch changed since the preview", async () => {
    const token = await loadToken();
    bridge.fingerprint = FP_B; // the user kept editing after confirming
    bridge.calls.length = 0;
    await expectCode(
      commitLoadPatch({ confirmationToken: token, operationId: randomUUID() }, ctx),
      "PATCH_CONFLICT",
    );
    expect(bridge.methods()).not.toContain("patchfile.load");
  });

  it("refuses when the patch epoch moved since the preview", async () => {
    const token = await loadToken();
    bridge.patchEpoch += 1;
    bridge.calls.length = 0;
    await expectCode(
      commitLoadPatch({ confirmationToken: token, operationId: randomUUID() }, ctx),
      "STALE_PATCH_EPOCH",
    );
    expect(bridge.methods()).not.toContain("patchfile.load");
  });

  it("refuses a token minted for another session", async () => {
    const token = await loadToken();
    bridge.instance = { ...INSTANCE, sessionId: "33333333-3333-4333-8333-333333333333" };
    await expectCode(
      commitLoadPatch({ confirmationToken: token, operationId: randomUUID() }, ctx),
      "CONFIRMATION_REQUIRED",
    );
  });

  it("commits a clear through patchfile.clear", async () => {
    const preview = (await previewClearPatch({}, ctx)) as PreviewResult;
    await commitClearPatch(
      { confirmationToken: preview.confirmation.confirmationToken, operationId: randomUUID() },
      ctx,
    );
    expect(bridge.methods()).toContain("patchfile.clear");
  });

  it("refuses a clear token for a load and vice versa", async () => {
    const clearPreview = (await previewClearPatch({}, ctx)) as PreviewResult;
    await expectCode(
      commitLoadPatch(
        { confirmationToken: clearPreview.confirmation.confirmationToken, operationId: randomUUID() },
        ctx,
      ),
      "CONFIRMATION_REQUIRED",
    );
    await expectCode(
      commitClearPatch({ confirmationToken: await loadToken(), operationId: randomUUID() }, ctx),
      "CONFIRMATION_REQUIRED",
    );
  });
});

describe("recovery checkpoint is a precondition, not best effort", () => {
  it("aborts the destructive step when the checkpoint cannot be written", async () => {
    const token = await loadToken();
    bridge.saveCopyError = new ToolError("INTERNAL", "disk full");
    await expectCode(
      commitLoadPatch({ confirmationToken: token, operationId: randomUUID() }, ctx),
      "INTERNAL",
    );
    expect(bridge.methods()).not.toContain("patchfile.load");
  });

  it("explains what failed and leaves the confirmation usable for a retry", async () => {
    const token = await loadToken();
    bridge.saveCopyError = new ToolError("PATH_NOT_ALLOWED", "checkpoints dir is read-only");
    await expect(
      commitLoadPatch({ confirmationToken: token, operationId: randomUUID() }, ctx),
    ).rejects.toThrow(/recovery checkpoint could not be created/);
    // Nothing mutated, so the same confirmation still works once the cause is fixed.
    bridge.saveCopyError = null;
    await expect(
      commitLoadPatch({ confirmationToken: token, operationId: randomUUID() }, ctx),
    ).resolves.toBeDefined();
    expect(bridge.methods()).toContain("patchfile.load");
  });

  it("aborts a clear the same way", async () => {
    const preview = (await previewClearPatch({}, ctx)) as PreviewResult;
    bridge.saveCopyError = new ToolError("INTERNAL", "archive failed");
    await expectCode(
      commitClearPatch(
        { confirmationToken: preview.confirmation.confirmationToken, operationId: randomUUID() },
        ctx,
      ),
      "INTERNAL",
    );
    expect(bridge.methods()).not.toContain("patchfile.clear");
  });
});

describe("restore_checkpoint", () => {
  it("restores the checkpoint it was asked for", async () => {
    const token = await restoreToken("cp-a.vcv");
    const res = (await restoreCheckpoint(
      {
        checkpointPath: join(cfg.checkpointsDir, "cp-a.vcv"),
        confirmationToken: token,
        operationId: randomUUID(),
      },
      ctx,
    )) as RestoreResult;
    expect(res.phase).toBe("restored");
    expect(bridge.payloadsFor("patchfile.load")[0]!.path).toBe(
      join(cfg.checkpointsDir, "cp-a.vcv"),
    );
  });

  it("refuses a token that names a different checkpoint than the argument", async () => {
    const token = await restoreToken("cp-a.vcv");
    bridge.calls.length = 0;
    await expectCode(
      restoreCheckpoint(
        {
          checkpointPath: join(cfg.checkpointsDir, "cp-b.vcv"),
          confirmationToken: token,
          operationId: randomUUID(),
        },
        ctx,
      ),
      "CONFIRMATION_REQUIRED",
    );
    expect(bridge.methods()).not.toContain("patchfile.load");
  });

  it("refuses a preview_load_patch token (it would load a patches-root file)", async () => {
    const token = await loadToken();
    bridge.calls.length = 0;
    await expectCode(
      restoreCheckpoint(
        {
          checkpointPath: join(cfg.checkpointsDir, "cp-a.vcv"),
          confirmationToken: token,
          operationId: randomUUID(),
        },
        ctx,
      ),
      "CONFIRMATION_REQUIRED",
    );
    expect(bridge.methods()).not.toContain("patchfile.load");
  });

  it("refuses a restore token in commit_load_patch", async () => {
    const token = await restoreToken("cp-a.vcv");
    await expectCode(
      commitLoadPatch({ confirmationToken: token, operationId: randomUUID() }, ctx),
      "CONFIRMATION_REQUIRED",
    );
  });

  it("still rejects a non-checkpoint path outright", async () => {
    await expectCode(
      restoreCheckpoint(
        { checkpointPath: join(cfg.patchesDir, "song.vcv"), operationId: randomUUID() },
        ctx,
      ),
      "PATH_NOT_ALLOWED",
    );
  });
});

describe("save_patch reports where it saved", () => {
  /**
   * `save_patch` with no `path` means "save where this patch already lives" --
   * Rack's own Save. The server has no idea where that is, and it was answering
   * `path: ""` alongside `saved: true`, telling a caller a file had been
   * written and refusing to say which. `SavePatchOutput.path` was only
   * `z.string()`, so the empty string satisfied the published contract too.
   *
   * The plugin now returns the path it settled on, and the schema requires one.
   */
  it("returns the path the plugin resolved when the caller supplied none", async () => {
    bridge.resolvedPath = "/somewhere/existing.vcv";
    const res = (await savePatch({ operationId: randomUUID() }, ctx)) as { path: string };
    expect(res.path).toBe("/somewhere/existing.vcv");
    expect(SavePatchOutput.safeParse(res).success).toBe(true);
  });

  it("prefers what the plugin says over what was requested", async () => {
    // The plugin is the authority on where the file went: it canonicalizes the
    // path it was handed and is the only side that can resolve an empty one.
    const target = join(cfg.patchesDir, "explicit.vcv");
    bridge.resolvedPath = target;
    const res = (await savePatch({ path: target, operationId: randomUUID() }, ctx)) as {
      path: string;
    };
    expect(res.path).toBe(target);
    expect(bridge.payloadsFor("patchfile.save")[0]!.path).toBe(target);
    expect(SavePatchOutput.safeParse(res).success).toBe(true);
  });

  it("falls back to the requested path if an older plugin sends none", async () => {
    // Version skew: a plugin built before this field still answers without it,
    // and the tool should still say something true rather than "".
    const target = join(cfg.patchesDir, "explicit.vcv");
    bridge.resolvedPath = "";
    const res = (await savePatch({ path: target, operationId: randomUUID() }, ctx)) as {
      path: string;
    };
    expect(res.path).toBe(target);
    expect(SavePatchOutput.safeParse(res).success).toBe(true);
  });

  it("no longer satisfies its own output schema with an empty path", () => {
    // The regression this guards: an empty path used to validate, so the
    // contract could not have caught the tool answering with nothing.
    const shaped = {
      path: "",
      fingerprint: FP_A,
      saved: true as const,
      bridgeModulePresent: true,
      warnings: [],
      replayed: false,
    };
    expect(SavePatchOutput.safeParse(shaped).success).toBe(false);
    expect(SavePatchOutput.safeParse({ ...shaped, path: "/p.vcv" }).success).toBe(true);
  });
});

describe("a checkpoint is contents, not an identity", () => {
  /**
   * `commitLoadOrClear` sent `setPath: true` for a restore as well as a load,
   * so `APP->patch->path` became the checkpoint file. Both `save_patch` with no
   * path and Rack's own Cmd/Ctrl+S write to that member, so restoring a
   * recovery point and then saving overwrote the recovery point -- the one file
   * whose whole job is to still be there.
   */
  it("restores without adopting the checkpoint as the patch path", async () => {
    const token = await restoreToken("cp-a.vcv");
    await restoreCheckpoint(
      {
        checkpointPath: join(cfg.checkpointsDir, "cp-a.vcv"),
        confirmationToken: token,
        operationId: randomUUID(),
      },
      ctx,
    );
    expect(bridge.payloadsFor("patchfile.load")[0]!.setPath).toBe(false);
  });

  it("still adopts the path for an ordinary load, which is what a load means", async () => {
    const token = await loadToken();
    await commitLoadPatch({ confirmationToken: token, operationId: randomUUID() }, ctx);
    expect(bridge.payloadsFor("patchfile.load")[0]!.setPath).toBe(true);
  });
});

describe("each root has exactly one door", () => {
  // `restoreCheckpoint` refused a source outside the checkpoints root and
  // nothing enforced the other three directions, which is how an ordinary save
  // could masquerade as a checkpoint and a load could adopt one.
  it("refuses to save into the checkpoints root", async () => {
    await expectCode(
      savePatch({ path: join(cfg.checkpointsDir, "cp-a.vcv"), operationId: randomUUID() }, ctx),
      "PATH_NOT_ALLOWED",
    );
    expect(bridge.methods()).not.toContain("patchfile.save");
  });

  it("refuses to save into the checkpoints root even under a new name", async () => {
    await expectCode(
      savePatch({ path: join(cfg.checkpointsDir, "sneaky.vcv"), operationId: randomUUID() }, ctx),
      "PATH_NOT_ALLOWED",
    );
  });

  it("still saves into the patches root", async () => {
    const target = join(cfg.patchesDir, "song.vcv");
    bridge.resolvedPath = target;
    await expect(savePatch({ path: target, operationId: randomUUID() }, ctx)).resolves.toBeDefined();
  });

  it("refuses to load a checkpoint through preview_load_patch", async () => {
    await expectCode(
      previewLoadPatch({ path: join(cfg.checkpointsDir, "cp-a.vcv") }, ctx),
      "PATH_NOT_ALLOWED",
    );
  });

  it("refuses at commit too, not only at the mint", async () => {
    // `commit_load_patch` takes its path from the token alone -- there is no
    // argument to re-check it against -- so without this the mint is the only
    // thing standing between a confirmation and a load of any resolvable file.
    // Unreachable through the shipped tools, which is the point: the guard is
    // here so a future mint cannot quietly become the whole policy.
    const token = await loadToken();
    vi.spyOn(ctx.txns, "verifyLoadToken").mockReturnValue({
      instanceId: INSTANCE.instanceId,
      sessionId: INSTANCE.sessionId,
      kind: "load",
      path: join(cfg.checkpointsDir, "cp-a.vcv"),
      patchEpoch: bridge.patchEpoch,
      fingerprint: bridge.fingerprint,
    });
    await expectCode(
      commitLoadPatch({ confirmationToken: token, operationId: randomUUID() }, ctx),
      "PATH_NOT_ALLOWED",
    );
    expect(bridge.methods()).not.toContain("patchfile.load");
  });
});

describe("a checkpoint name is claimed, not computed", () => {
  /**
   * The name is a lossy encoding of (millisecond, label) three times over --
   * millisecond resolution, `[^A-Za-z0-9_-]` collapsed to `_`, and a 40-char
   * cut -- and `savePatchAtomic` renames over whatever is at the destination.
   * Two `create_checkpoint` calls that collide destroy one recovery point, and
   * there is no retention anywhere to keep a second copy.
   */
  const FIXED = Date.parse("2026-09-08T12:00:00.000Z");

  function freezeClock(): void {
    vi.spyOn(Date, "now").mockReturnValue(FIXED);
  }

  it("gives two same-millisecond checkpoints different files", async () => {
    freezeClock();
    const a = (await createCheckpoint({ label: "same", operationId: randomUUID() }, ctx)) as {
      checkpointPath: string;
    };
    const b = (await createCheckpoint({ label: "same", operationId: randomUUID() }, ctx)) as {
      checkpointPath: string;
    };
    expect(b.checkpointPath).not.toBe(a.checkpointPath);
    expect(existsSync(a.checkpointPath)).toBe(true);
    expect(existsSync(b.checkpointPath)).toBe(true);
  });

  it("separates labels that sanitisation would otherwise merge", async () => {
    freezeClock();
    const a = (await createCheckpoint({ label: "a/b", operationId: randomUUID() }, ctx)) as {
      checkpointPath: string;
    };
    const b = (await createCheckpoint({ label: "a:b", operationId: randomUUID() }, ctx)) as {
      checkpointPath: string;
    };
    expect(b.checkpointPath).not.toBe(a.checkpointPath);
  });

  it("separates labels that truncation would otherwise merge", async () => {
    freezeClock();
    const long = "x".repeat(40);
    const a = (await createCheckpoint({ label: long + "AAA", operationId: randomUUID() }, ctx)) as {
      checkpointPath: string;
    };
    const b = (await createCheckpoint({ label: long + "BBB", operationId: randomUUID() }, ctx)) as {
      checkpointPath: string;
    };
    expect(b.checkpointPath).not.toBe(a.checkpointPath);
  });

  it("does not leave an empty .vcv behind when the save never lands", async () => {
    freezeClock();
    bridge.saveCopyError = new ToolError("INTERNAL", "disk full");
    await expectCode(createCheckpoint({ label: "doomed", operationId: randomUUID() }, ctx), "INTERNAL");
    const stray = readdirSync(cfg.checkpointsDir).filter((f) => /doomed/.test(f));
    expect(stray).toEqual([]);
  });

  it("does not leave one behind when the recovery checkpoint fails either", async () => {
    const token = await loadToken();
    bridge.saveCopyError = new ToolError("INTERNAL", "disk full");
    await expectCode(
      commitLoadPatch({ confirmationToken: token, operationId: randomUUID() }, ctx),
      "INTERNAL",
    );
    const stray = readdirSync(cfg.checkpointsDir).filter((f) => /recovery/.test(f));
    expect(stray).toEqual([]);
  });

  it("keeps a checkpoint the plugin did write, whatever else went wrong", () => {
    // The release is guarded on emptiness on purpose: once the archive has
    // landed, the file is a recovery point and outranks any tidying.
    const kept = join(cfg.checkpointsDir, "cp-a.vcv");
    expect(statSync(kept).size).toBeGreaterThan(0);
    releaseCheckpointReservation(kept);
    expect(existsSync(kept)).toBe(true);
  });
});

describe("a reservation is only taken back when the plugin says it wrote nothing", () => {
  /**
   * `releaseCheckpointReservation` is `statSync` then `unlinkSync` -- two
   * syscalls, so a write landing between them is deleted. What makes that safe
   * is not the size guard alone but WHEN it runs: `savePatchAtomic` archives
   * into a sibling temp and renames only on success, so an error the plugin
   * reports proves the destination is untouched. A timeout proves nothing --
   * the UI thread may still be saving, and the deadline only bounds this side.
   */
  it("keeps the reservation when the call timed out", async () => {
    bridge.saveCopyError = new ToolError("TIMEOUT", "the plugin did not answer in time");
    await expectCode(createCheckpoint({ label: "slow", operationId: randomUUID() }, ctx), "TIMEOUT");
    const left = readdirSync(cfg.checkpointsDir).filter((f) => /slow/.test(f));
    expect(left.length, "a timed-out save may still be in flight").toBe(1);
    expect(statSync(join(cfg.checkpointsDir, left[0]!)).size).toBe(0);
  });

  it("keeps it when the connection dropped, for the same reason", async () => {
    bridge.saveCopyError = new ToolError("RACK_DISCONNECTED", "the bridge went away");
    await expectCode(
      createCheckpoint({ label: "gone", operationId: randomUUID() }, ctx),
      "RACK_DISCONNECTED",
    );
    expect(readdirSync(cfg.checkpointsDir).filter((f) => /gone/.test(f)).length).toBe(1);
  });

  it("but a file the write never reached is not offered as something to restore", async () => {
    // Which is what makes leaving it harmless: an empty .vcv is refused on the
    // read side, because loading one clears the patch and then throws.
    bridge.saveCopyError = new ToolError("TIMEOUT", "the plugin did not answer in time");
    await expectCode(createCheckpoint({ label: "slow", operationId: randomUUID() }, ctx), "TIMEOUT");
    const left = readdirSync(cfg.checkpointsDir).find((f) => /slow/.test(f))!;
    await expectCode(
      restoreCheckpoint(
        { checkpointPath: join(cfg.checkpointsDir, left), operationId: randomUUID() },
        ctx,
      ),
      "PATH_NOT_ALLOWED",
    );
  });

  it("refuses an empty patch file on the load side too", async () => {
    writeFileSync(join(cfg.patchesDir, "truncated.vcv"), "");
    await expectCode(
      previewLoadPatch({ path: join(cfg.patchesDir, "truncated.vcv") }, ctx),
      "PATH_NOT_ALLOWED",
    );
  });
});

describe("the recovery-checkpoint failure contract covers the whole checkpoint write", () => {
  /**
   * Claiming the name is now the first thing that touches the checkpoints
   * directory, so the cause the contract names -- a full or unwritable
   * checkpoints dir -- reaches the reservation before it reaches the plugin.
   * Taken outside the try, it escaped as a bare error that never said the load
   * had not happened, and with `retrySafe` inverted.
   */
  const posix = platform() !== "win32";

  it.skipIf(!posix)("wraps an unwritable checkpoints directory, and aborts the load", async () => {
    const token = await loadToken();
    chmodSync(cfg.checkpointsDir, 0o500);
    try {
      await expect(
        commitLoadPatch({ confirmationToken: token, operationId: randomUUID() }, ctx),
      ).rejects.toThrow(/recovery checkpoint could not be created/);
    } finally {
      chmodSync(cfg.checkpointsDir, 0o700);
    }
    expect(bridge.methods()).not.toContain("patchfile.load");
  });

  it.skipIf(!posix)("reports it as retry-safe, because nothing was mutated", async () => {
    const token = await loadToken();
    chmodSync(cfg.checkpointsDir, 0o500);
    let caught: ToolError | null = null;
    try {
      await commitLoadPatch({ confirmationToken: token, operationId: randomUUID() }, ctx);
    } catch (e) {
      caught = e as ToolError;
    } finally {
      chmodSync(cfg.checkpointsDir, 0o700);
    }
    expect(caught).toBeInstanceOf(ToolError);
    expect(caught!.retrySafe).toBe(true);
    // And the confirmation survives, so fixing the directory is enough.
    await expect(
      commitLoadPatch({ confirmationToken: token, operationId: randomUUID() }, ctx),
    ).resolves.toBeDefined();
  });

  it.skipIf(!posix)("does not answer PATH_NOT_ALLOWED for a path that is inside the root", async () => {
    // The published remedy for that code is "use a path within the configured
    // roots", which cannot fix a read-only directory.
    chmodSync(cfg.checkpointsDir, 0o500);
    let caught: ToolError | null = null;
    try {
      await createCheckpoint({ label: "nowhere", operationId: randomUUID() }, ctx);
    } catch (e) {
      caught = e as ToolError;
    } finally {
      chmodSync(cfg.checkpointsDir, 0o700);
    }
    expect(caught!.code).toBe("INTERNAL");
    expect(caught!.message).toMatch(/checkpoints directory writable/);
  });
});

describe("reserveCheckpointPath", () => {
  it("creates the file it returns, rather than promising a free name", () => {
    // The distinction the whole function exists for. A `existsSync`-then-return
    // implementation passes every test that only compares two names; this one
    // fails it, because there would be nothing on disk to collide with.
    const first = reserveCheckpointPath(cfg, "claimed", 1_760_000_000_000);
    expect(existsSync(first)).toBe(true);
    expect(statSync(first).size).toBe(0);
    const second = reserveCheckpointPath(cfg, "claimed", 1_760_000_000_000);
    expect(second).not.toBe(first);
    expect(existsSync(second)).toBe(true);
    // Atomicity itself cannot be shown in-process -- `wx` is what closes the
    // window between deciding a name is free and taking it, and no single-
    // threaded test can be inside that window. What is pinned here is that the
    // name is taken at all.
  });

  it("never hands out a name that already holds a checkpoint", () => {
    const taken = reserveCheckpointPath(cfg, "occupied", 1_760_000_000_000);
    writeFileSync(taken, "a real archive");
    const next = reserveCheckpointPath(cfg, "occupied", 1_760_000_000_000);
    expect(next).not.toBe(taken);
    expect(statSync(taken).size).toBeGreaterThan(0);
  });
});

describe("one file, one name", () => {
  /**
   * `create_checkpoint` builds its name on the realpath'd root and
   * `list_patch_files` joined the configured string, so under a symlinked root
   * the same file came back under two names and a client tracking checkpoints
   * by path saw two. Not hypothetical: every macOS temp dir is reached through
   * `/var -> private/var`, which is why this file realpaths its own temp dir at
   * the top -- and why the roots have to be reached through a link here for the
   * check to mean anything.
   */
  function throughASymlink(): ServerConfig {
    const real = join(dir, "real-user-dir");
    mkdirSync(join(real, "patches"), { recursive: true });
    mkdirSync(join(real, "RackMCP", "checkpoints"), { recursive: true });
    const link = join(dir, "linked-user-dir");
    symlinkSync(real, link, "dir");
    return configFor(link);
  }

  it("lists a checkpoint under the same path create_checkpoint returned", async () => {
    const linked = throughASymlink();
    bindServerConfig(ctx, linked);
    expect(linked.checkpointsDir).not.toBe(realpathSync.native(linked.checkpointsDir));

    const made = (await createCheckpoint({ label: "named", operationId: randomUUID() }, ctx)) as {
      checkpointPath: string;
    };
    const listed = (await listPatchFiles({ root: "checkpoints" }, ctx)) as {
      files: { path: string }[];
      roots: { checkpoints: string };
    };
    expect(listed.files.map((f) => f.path)).toContain(made.checkpointPath);
    expect(made.checkpointPath.startsWith(listed.roots.checkpoints)).toBe(true);
  });
});
