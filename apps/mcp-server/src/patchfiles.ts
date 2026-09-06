import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { platform } from "node:os";
import { randomUUID } from "node:crypto";
import type { PatchFileResult } from "@rackmcp/schemas";
import type { ServerConfig } from "./config.js";
import type { ConnectionManager, SelectedInstance } from "./connection.js";
import { ToolError, toErrorPayload } from "./errors.js";
import { checkpointPath, resolvePatchPath, type PatchRoot } from "./paths.js";
import type { ToolContext, ToolHandler } from "./tools.js";

/**
 * Patch-file tools (spec section 8). The server owns path policy and the
 * recovery-checkpoint orchestration; the plugin performs the actual .vcv I/O
 * via Rack's patch manager and reports Bridge presence.
 */

interface PatchFingerprint {
  fingerprint: string;
  patchEpoch: number;
}

function scopeFor(instance: SelectedInstance) {
  return { instanceId: instance.instanceId, sessionId: instance.sessionId, patchEpoch: 0 };
}

/** Canonical patch paths compare case-insensitively on Windows, like the roots. */
function samePath(a: string | null, b: string): boolean {
  if (a === null) return false;
  return platform() === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * The plugin inserts a Bridge module whenever the patch that results from a
 * load or clear lacks one, and the server cannot look inside a .vcv archive to
 * tell in advance. The spec requires the insertion to be disclosed in the
 * preview, so disclose it conditionally rather than under-report it; the
 * schema field is a plain boolean with no "unknown" value.
 */
const BRIDGE_INSERTION_NOTICE =
  "a RackMCP-Bridge module will be inserted into the resulting patch if it does not already contain one, which changes the layout of the loaded file";

function listRoot(dir: string, root: PatchRoot) {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".vcv"));
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    try {
      const full = join(dir, name);
      const st = statSync(full);
      if (!st.isFile()) return [];
      return [{
        path: full,
        name,
        sizeBytes: st.size,
        modifiedAt: new Date(st.mtimeMs).toISOString(),
        root,
      }];
    } catch {
      return [];
    }
  });
}

export const listPatchFiles: ToolHandler = async (args, ctx) => {
  const config = serverConfig(ctx);
  const which = (args.root as "patches" | "checkpoints" | "all") ?? "all";
  const files = [
    ...(which === "patches" || which === "all" ? listRoot(config.patchesDir, "patches") : []),
    ...(which === "checkpoints" || which === "all"
      ? listRoot(config.checkpointsDir, "checkpoints")
      : []),
  ].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));

  const limit = (args.limit as number) ?? 100;
  const start = args.cursor ? Number(args.cursor) : 0;
  const page = files.slice(start, start + limit);
  return {
    files: page,
    nextCursor: start + limit < files.length ? String(start + limit) : null,
    roots: { patches: config.patchesDir, checkpoints: config.checkpointsDir },
  };
};

export const createCheckpoint: ToolHandler = async (args, ctx) => {
  const config = serverConfig(ctx);
  const instance = await ctx.conn.ensureConnected();
  await ctx.conn.ensureLease();
  const stampMs = Date.now();
  const path = checkpointPath(config, args.label as string | undefined, stampMs);
  const res = await ctx.conn.request<PatchFileResult>(
    "patchfile.saveCopy",
    { scope: scopeFor(instance), path, operationId: args.operationId },
    { operationId: args.operationId as string, deadlineMs: 60_000 },
  );
  return {
    checkpointPath: path,
    fingerprint: res.fingerprint,
    createdAt: new Date(stampMs).toISOString(),
    replayed: res.replayed,
  };
};

export const savePatch: ToolHandler = async (args, ctx) => {
  const config = serverConfig(ctx);
  const instance = await ctx.conn.ensureConnected();
  await ctx.conn.ensureLease();
  let path: string | undefined;
  if (args.path) {
    path = resolvePatchPath(config, args.path as string, { mustExist: false }).absolute;
  }
  const res = await ctx.conn.request<PatchFileResult>(
    "patchfile.save",
    { scope: scopeFor(instance), path: path ?? "", operationId: args.operationId },
    { operationId: args.operationId as string, deadlineMs: 60_000 },
  );
  // The plugin reports where it actually saved. That matters when no path was
  // requested: "save" then means "save where this patch already lives", which
  // only the plugin can resolve, and this used to answer with "" for a file it
  // had just written.
  const savedAt = res.path || path || "";
  return {
    path: savedAt,
    fingerprint: res.fingerprint,
    saved: true as const,
    bridgeModulePresent: res.bridgeModulePresent,
    warnings: res.warnings,
    replayed: res.replayed,
  };
};

/** Builds a load/clear preview + confirmation token via the txn manager's key. */
async function buildLoadPreview(
  ctx: ToolContext,
  kind: "load" | "clear",
  targetPath: string | null,
) {
  const config = serverConfig(ctx);
  const instance = await ctx.conn.ensureConnected();
  const status = await ctx.conn.request<Record<string, unknown>>("status.get", {});
  const currentSaved = status.saved === true;
  // The state the preview describes; the token binds it and the commit
  // re-verifies it, so a confirmation cannot outlive the facts shown here.
  const live = await ctx.conn.request<PatchFingerprint>("patch.fingerprint", {});

  let exists = false;
  let sizeBytes: number | null = null;
  if (kind === "load" && targetPath) {
    const resolved = resolvePatchPath(config, targetPath, { mustExist: true });
    exists = resolved.exists;
    sizeBytes = statSync(resolved.absolute).size;
  }

  const preview = {
    path: targetPath,
    exists: kind === "load" ? exists : true,
    sizeBytes,
    currentPatchSaved: currentSaved,
    willCreateRecoveryCheckpoint: true,
    recoveryCheckpointImpossibleReason: null,
    // A load/clear always yields a Bridge module (the plugin reinserts one if
    // the resulting patch lacks it) so it can reconnect after restart. For a
    // load the target's contents are unknown here, so the insertion is
    // disclosed as conditional in the warnings.
    willInsertBridgeModule: true,
    risk: {
      level: "high" as const,
      flags: kind === "clear" ? ["clears_patch"] : ["replaces_patch"],
      reasons: [
        kind === "clear"
          ? "clears the entire current patch"
          : "replaces the entire current patch with a loaded file",
        ...(currentSaved ? [] : ["the current patch has unsaved changes"]),
      ],
      confirmationRequired: true,
    },
    warnings: [
      ...(currentSaved ? [] : ["the current patch has unsaved changes"]),
      BRIDGE_INSERTION_NOTICE,
    ],
  };

  const token = ctx.txns.mintLoadToken({
    instanceId: instance.instanceId,
    sessionId: instance.sessionId,
    kind,
    path: targetPath,
    patchEpoch: live.patchEpoch,
    fingerprint: live.fingerprint,
  });
  return {
    preview,
    confirmation: {
      confirmationToken: token,
      confirmationExpiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      confirmationRequired: true,
    },
  };
}

export const previewLoadPatch: ToolHandler = async (args, ctx) => {
  const config = serverConfig(ctx);
  // Validate the path eagerly so preview surfaces PATH_NOT_ALLOWED.
  resolvePatchPath(config, args.path as string, { mustExist: true });
  return buildLoadPreview(ctx, "load", args.path as string);
};

export const previewClearPatch: ToolHandler = async (_args, ctx) => {
  return buildLoadPreview(ctx, "clear", null);
};

async function commitLoadOrClear(
  ctx: ToolContext,
  kind: "load" | "clear" | "restore",
  confirmationToken: string,
  operationId: string,
  expectedPath?: string,
) {
  const config = serverConfig(ctx);
  const instance = await ctx.conn.ensureConnected();
  const binding = ctx.txns.verifyLoadToken(confirmationToken);
  if (
    binding.kind !== kind ||
    binding.instanceId !== instance.instanceId ||
    binding.sessionId !== instance.sessionId
  ) {
    throw new ToolError("CONFIRMATION_REQUIRED", "confirmation token does not match this operation");
  }
  // The caller named a file and this tool policy-checked it; the token must
  // bind that exact file or the check would apply to a path never loaded.
  if (expectedPath !== undefined && !samePath(binding.path, expectedPath)) {
    throw new ToolError(
      "CONFIRMATION_REQUIRED",
      "confirmation token was issued for a different patch file",
    );
  }

  // The patch the user confirmed against must still be the live one: the
  // preview's facts (unsaved changes, epoch) are what the confirmation means.
  const live = await ctx.conn.request<PatchFingerprint>("patch.fingerprint", {});
  if (live.patchEpoch !== binding.patchEpoch) {
    throw new ToolError(
      "STALE_PATCH_EPOCH",
      "the patch was replaced since the preview; re-run the preview and confirm again",
    );
  }
  if (live.fingerprint !== binding.fingerprint) {
    throw new ToolError(
      "PATCH_CONFLICT",
      "the patch changed since the preview; re-run the preview and confirm again",
    );
  }

  await ctx.conn.ensureLease();

  // Automatic recovery checkpoint before the destructive operation. The spec
  // allows skipping it only when the preview said why it was impossible, and
  // every preview here promises one, so a failure aborts: the current patch is
  // never destroyed with the safety net missing. Nothing has mutated yet, so
  // the confirmation token stays valid and the commit can simply be retried.
  const stampMs = Date.now();
  const recoveryPath = checkpointPath(config, "recovery", stampMs);
  try {
    await ctx.conn.request<PatchFileResult>(
      "patchfile.saveCopy",
      { scope: scopeFor(instance), path: recoveryPath, operationId: randomUUID() },
      { operationId: randomUUID(), deadlineMs: 60_000 },
    );
  } catch (err) {
    const cause = toErrorPayload(err);
    throw new ToolError(
      cause.code,
      `the recovery checkpoint could not be created (${cause.code}: ${cause.message}), so the ${kind} was not performed; make the checkpoints directory writable with free space, then retry`,
      true,
    );
  }
  const recoveryCheckpointPath = recoveryPath;

  // Single use, like a committed transaction plan: burn the confirmation
  // before the irreversible step so one preview authorises one replacement.
  ctx.txns.consumeLoadToken(confirmationToken);

  let res: PatchFileResult;
  if (kind === "load" || kind === "restore") {
    const resolved = resolvePatchPath(config, binding.path!, { mustExist: true });
    res = await ctx.conn.request<PatchFileResult>(
      "patchfile.load",
      { scope: scopeFor(instance), path: resolved.absolute, setPath: true, operationId },
      { operationId, deadlineMs: 60_000 },
    );
  } else {
    res = await ctx.conn.request<PatchFileResult>(
      "patchfile.clear",
      { scope: scopeFor(instance), operationId },
      { operationId, deadlineMs: 60_000 },
    );
  }
  return {
    fingerprint: res.fingerprint,
    patchEpoch: res.patchEpoch,
    patchName: res.patchName,
    saved: res.saved,
    bridgeModulePresent: res.bridgeModulePresent,
    recoveryCheckpointPath,
    warnings: res.warnings,
    replayed: res.replayed,
  };
}

export const commitLoadPatch: ToolHandler = async (args, ctx) => {
  return commitLoadOrClear(ctx, "load", args.confirmationToken as string, args.operationId as string);
};

export const commitClearPatch: ToolHandler = async (args, ctx) => {
  return commitLoadOrClear(ctx, "clear", args.confirmationToken as string, args.operationId as string);
};

export const restoreCheckpoint: ToolHandler = async (args, ctx) => {
  const config = serverConfig(ctx);
  const checkpoint = resolvePatchPath(config, args.checkpointPath as string, { mustExist: true });
  if (checkpoint.root !== "checkpoints") {
    throw new ToolError("PATH_NOT_ALLOWED", "restore source must be a checkpoint file");
  }
  const instance = await ctx.conn.ensureConnected();

  if (!args.confirmationToken) {
    // Preview phase.
    const status = await ctx.conn.request<Record<string, unknown>>("status.get", {});
    const live = await ctx.conn.request<PatchFingerprint>("patch.fingerprint", {});
    // Kind "restore" keeps restore and load confirmations from being used for
    // each other: a load token names a patches-root file this tool refuses.
    const token = ctx.txns.mintLoadToken({
      instanceId: instance.instanceId,
      sessionId: instance.sessionId,
      kind: "restore",
      path: checkpoint.absolute,
      patchEpoch: live.patchEpoch,
      fingerprint: live.fingerprint,
    });
    return {
      phase: "preview" as const,
      preview: {
        path: checkpoint.absolute,
        exists: true,
        sizeBytes: statSync(checkpoint.absolute).size,
        currentPatchSaved: status.saved === true,
        willCreateRecoveryCheckpoint: true,
        recoveryCheckpointImpossibleReason: null,
        willInsertBridgeModule: true,
        risk: {
          level: "high" as const,
          flags: ["replaces_patch"],
          reasons: ["restoring a checkpoint replaces the entire current patch"],
          confirmationRequired: true,
        },
        warnings: [
          ...(status.saved === true ? [] : ["the current patch has unsaved changes"]),
          BRIDGE_INSERTION_NOTICE,
        ],
      },
      confirmation: {
        confirmationToken: token,
        confirmationExpiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        confirmationRequired: true,
      },
    };
  }

  const result = await commitLoadOrClear(
    ctx,
    "restore",
    args.confirmationToken as string,
    args.operationId as string,
    checkpoint.absolute,
  );
  return { phase: "restored" as const, result };
};

// --- config access from context (kept private to this module) ---
const CONFIGS = new WeakMap<object, ServerConfig>();
export function bindServerConfig(ctx: object, config: ServerConfig): void {
  CONFIGS.set(ctx, config);
}
function serverConfig(ctx: ToolContext): ServerConfig {
  const c = CONFIGS.get(ctx);
  if (!c) throw new ToolError("INTERNAL", "server config not bound");
  return c;
}
