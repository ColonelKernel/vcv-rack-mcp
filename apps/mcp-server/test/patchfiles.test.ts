import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ServerConfig } from "../src/config.js";
import type { ConnectionManager, SelectedInstance } from "../src/connection.js";
import { ToolError } from "../src/errors.js";
import { TransactionManager } from "../src/transactions.js";
import {
  bindServerConfig,
  commitClearPatch,
  commitLoadPatch,
  previewClearPatch,
  previewLoadPatch,
  restoreCheckpoint,
} from "../src/patchfiles.js";
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
  rmSync(dir, { recursive: true, force: true });
});

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
