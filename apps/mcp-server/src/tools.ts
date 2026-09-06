import { z } from "zod";
import { getTool, TOOLS, type ToolSpec, LIMITS } from "@rackmcp/schemas";
import { getAdapter, hasAdapter } from "@rackmcp/adapters";
import type { ConnectionManager } from "./connection.js";
import { ToolError } from "./errors.js";
import { randomUUID } from "node:crypto";
import { TransactionManager } from "./transactions.js";
import { listInstanceSummaries, mapStatus } from "./projections.js";
import { getRecipe, resolveRecipe, expandRecipeOperations } from "@rackmcp/recipes";
import { scanInstalledModels } from "./resources.js";

/** Everything a tool handler needs. */
export interface ToolContext {
  conn: ConnectionManager;
  txns: TransactionManager;
  serverVersion: string;
  bridgeProtocolVersion: number;
}

export type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Connection and discovery
// ---------------------------------------------------------------------------

const listRackInstances: ToolHandler = async (_args, ctx) => {
  return {
    discoveryDir: (ctx.conn as unknown as { config: { discoveryDir: string } }).config?.discoveryDir ?? "",
    instances: listInstanceSummaries(ctx.conn),
  };
};

const selectRackInstance: ToolHandler = async (args, ctx) => {
  const instanceId = args.instanceId as string;
  await ctx.conn.select(instanceId);
  const status = await ctx.conn.request<Record<string, unknown>>("status.get", {});
  return { status: mapStatus(status), connected: true as const };
};

const getRackStatus: ToolHandler = async (_args, ctx) => {
  const selected = ctx.conn.selectedInstance;
  if (!selected || !ctx.conn.connected) {
    return {
      status: null,
      connected: false,
      selectedInstanceId: selected?.instanceId ?? null,
      userNotesPending: false,
      server: serverInfo(ctx),
    };
  }
  const status = await ctx.conn.request<Record<string, unknown>>("status.get", {});
  let metrics: Record<string, unknown> | undefined;
  try {
    metrics = await ctx.conn.request<Record<string, unknown>>("metrics.get", {});
  } catch {
    metrics = undefined;
  }
  return {
    status: mapStatus(status),
    connected: true,
    selectedInstanceId: selected.instanceId,
    userNotesPending: ctx.conn.hasPendingUserNotes(),
    server: { ...serverInfo(ctx), ...(metrics ? { metrics } : {}) },
  };
};

function serverInfo(ctx: ToolContext) {
  return {
    serverVersion: ctx.serverVersion,
    bridgeProtocolVersion: ctx.bridgeProtocolVersion,
    supportedRackVersions: ["2.6.6"],
  };
}

const acquireWriterLease: ToolHandler = async (_args, ctx) => {
  const res = await ctx.conn.acquireLease();
  return { leaseId: res.leaseId, expiresInMs: res.expiresInMs };
};

const releaseWriterLease: ToolHandler = async (_args, ctx) => {
  const released = await ctx.conn.releaseLease();
  return { released };
};

// ---------------------------------------------------------------------------
// Catalog and inspection
// ---------------------------------------------------------------------------

const listInstalledModels: ToolHandler = async (args, ctx) => {
  // The bridge already speaks CatalogListResult; renaming its keys here is
  // what let the published output schema drift away from the wire shape.
  return ctx.conn.request<Record<string, unknown>>("catalog.listModels", {
    cursor: args.cursor,
    limit: args.limit ?? 100,
    query: args.query,
  });
};

const inspectModel: ToolHandler = async (args, ctx) => {
  const meta = await ctx.conn.request<Record<string, unknown>>("catalog.inspectModel", {
    pluginSlug: args.pluginSlug,
    modelSlug: args.modelSlug,
  });
  const adapter = getAdapter(String(args.pluginSlug), String(args.modelSlug));
  return {
    ...meta,
    adapterAvailable: adapter !== undefined,
    adapterVersionRange: adapter?.pluginVersionRange ?? null,
  };
};

const getPatchSnapshot: ToolHandler = async (args, ctx) => {
  return ctx.conn.request<Record<string, unknown>>("patch.snapshot", {
    includeOpaqueState: args.includeOpaqueState ?? false,
    expectedPatchEpoch: args.expectedPatchEpoch,
  });
};

const inspectModule: ToolHandler = async (args, ctx) => {
  const res = await ctx.conn.request<{ module: Record<string, unknown> }>("module.inspect", {
    moduleId: args.moduleId,
    includeOpaqueState: args.includeOpaqueState ?? false,
    expectedPatchEpoch: args.expectedPatchEpoch,
  });
  const pluginSlug = String(res.module.pluginSlug ?? "");
  const modelSlug = String(res.module.modelSlug ?? "");
  const available = hasAdapter(pluginSlug, modelSlug);
  return {
    module: res.module,
    adapterAvailable: available,
    semanticsConfidence: available ? "adapter" : "none",
  };
};

const inspectParameter: ToolHandler = async (args, ctx) => {
  const res = await ctx.conn.request<{ module: Record<string, unknown> }>("module.inspect", {
    moduleId: args.moduleId,
    expectedPatchEpoch: args.expectedPatchEpoch,
  });
  const params = (res.module.params as Array<Record<string, unknown>>) ?? [];
  const param = params.find((p) => p.paramId === args.paramId);
  if (!param) {
    throw new ToolError("PARAMETER_NOT_FOUND", `module ${args.moduleId} has no param ${args.paramId}`);
  }
  const pluginSlug = String(res.module.pluginSlug ?? "");
  const modelSlug = String(res.module.modelSlug ?? "");
  const role = getAdapter(pluginSlug, modelSlug)?.params.find(
    (p) => p.paramId === (args.paramId as number),
  )?.role;
  return {
    param,
    moduleId: args.moduleId,
    adapterRole: role ?? null,
    semanticsConfidence: role ? "adapter" : "none",
  };
};

// ---------------------------------------------------------------------------
// Registry wiring
// ---------------------------------------------------------------------------

import { describePatch, validatePatch } from "./analysis.js";
import {
  bindServerConfig,
  commitClearPatch,
  commitLoadPatch,
  createCheckpoint,
  listPatchFiles,
  previewClearPatch,
  previewLoadPatch,
  restoreCheckpoint,
  savePatch,
} from "./patchfiles.js";
export { bindServerConfig };
import {
  commitAttachProbe,
  detachProbe,
  listProbes,
  previewAttachProbe,
  readProbe,
} from "./telemetry.js";
import { postChatMessage, readUserNotes } from "./chat.js";

// ---------------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------------

const previewPatchTransaction: ToolHandler = async (args, ctx) => {
  const instance = await ctx.conn.ensureConnected();
  // The declared expectedFingerprint/expectedPatchEpoch guards are enforced by
  // the transaction manager (spec section 6 step 3); dropping them here would
  // make a caller's stale-state check a silent no-op.
  return ctx.txns.preview(args.label as string, args.operations as unknown[], instance, {
    fingerprint: args.expectedFingerprint as string | undefined,
    patchEpoch: args.expectedPatchEpoch as number | undefined,
  });
};

const commitPatchTransaction: ToolHandler = async (args, ctx) => {
  const instance = await ctx.conn.ensureConnected();
  return ctx.txns.commit({
    operationId: args.operationId as string,
    planHash: args.planHash as string,
    expectedFingerprint: args.expectedFingerprint as string,
    confirmationToken: args.confirmationToken as string | undefined,
    instance,
  });
};

/**
 * Preview a plan and commit it when nothing needs confirming.
 *
 * Shared by build_patch and build_recipe so the two cannot drift on the one
 * decision that matters here -- whether to commit without asking. Two copies of
 * this would be two places to get the confirmation gate wrong.
 */
async function previewAndMaybeCommit(
  ctx: ToolContext,
  instance: Awaited<ReturnType<ConnectionManager["ensureConnected"]>>,
  label: string,
  operations: unknown[],
  opts: { autoCommit: boolean; operationId: string; expectedPatchEpoch: number | undefined },
): Promise<{
  phase: "previewed" | "committed";
  preview: Awaited<ReturnType<TransactionManager["preview"]>>["preview"];
  confirmation: Awaited<ReturnType<TransactionManager["preview"]>>["confirmation"];
  commit?: Awaited<ReturnType<TransactionManager["commit"]>>;
}> {
  const { preview, confirmation } = await ctx.txns.preview(label, operations, instance, {
    patchEpoch: opts.expectedPatchEpoch,
  });
  // Never bypass confirmation: risky plans stop at the preview with a token.
  if (!opts.autoCommit || confirmation.confirmationRequired) {
    return { phase: "previewed" as const, preview, confirmation };
  }
  const commit = await ctx.txns.commit({
    operationId: opts.operationId,
    planHash: preview.planHash,
    expectedFingerprint: preview.baseFingerprint,
    instance,
  });
  return { phase: "committed" as const, preview, confirmation, commit };
}

const buildPatch: ToolHandler = async (args, ctx) => {
  const instance = await ctx.conn.ensureConnected();
  return previewAndMaybeCommit(ctx, instance, args.label as string, args.operations as unknown[], {
    autoCommit: (args.autoCommit as boolean | undefined) ?? true,
    operationId: args.operationId as string,
    expectedPatchEpoch: args.expectedPatchEpoch as number | undefined,
  });
};

/**
 * Build a patch from the recipe library.
 *
 * Until this existed, `packages/recipes` could only be READ: `rack://recipes`
 * published the recipes and their resolutions, and a client wanting to build
 * one had to reconstruct the operations itself from the published template --
 * re-implementing role substitution, and getting no benefit from the
 * expansion the package already does correctly.
 */
const buildRecipe: ToolHandler = async (args, ctx) => {
  const recipeId = args.recipeId as string;
  const recipe = getRecipe(recipeId);
  if (!recipe) {
    throw new ToolError(
      "BAD_REQUEST",
      `no recipe with id "${recipeId}"; see rack://recipes for the available ids`,
      true,
    );
  }

  const instance = await ctx.conn.ensureConnected();
  const scan = await scanInstalledModels(ctx.conn);
  const resolution = resolveRecipe(recipe, scan.models);

  // An unresolved recipe is an answer, not an error: it names what is missing.
  // Substitution is deliberately not attempted -- expansion rewrites the
  // add_module slugs but keeps the port and parameter ids chosen for the
  // preferred model, so a swapped-in module would build without error and be
  // wired wrong.
  if (!resolution.resolved) {
    return {
      phase: "unresolved" as const,
      recipeId,
      resolution,
      catalogComplete: scan.complete,
    };
  }

  const result = await previewAndMaybeCommit(
    ctx,
    instance,
    (args.label as string | undefined) ?? recipe.name,
    expandRecipeOperations(recipe, resolution),
    {
      autoCommit: (args.autoCommit as boolean | undefined) ?? true,
      operationId: args.operationId as string,
      expectedPatchEpoch: args.expectedPatchEpoch as number | undefined,
    },
  );
  return { ...result, recipeId, resolution, catalogComplete: scan.complete };
};

const undoLastMcpTransaction: ToolHandler = async (args, ctx) => {
  const instance = await ctx.conn.ensureConnected();
  await ctx.conn.ensureLease();
  // The undo needs its OWN idempotency key, distinct from the transaction it
  // targets — reusing the target's id would collide with that commit's cached
  // result and replay it instead of undoing.
  const undoOperationId = randomUUID();
  const res = await ctx.conn.request<{ undone: true; newFingerprint: string; patchEpoch: number }>(
    "txn.undoLast",
    {
      scope: { instanceId: instance.instanceId, sessionId: instance.sessionId, patchEpoch: 0 },
      expectedOperationId: args.operationId,
      operationId: undoOperationId,
    },
    { operationId: undoOperationId },
  );
  return {
    undone: true as const,
    undoneOperationId: args.operationId,
    newFingerprint: res.newFingerprint,
    patchEpoch: res.patchEpoch,
  };
};

const HANDLERS: Record<string, ToolHandler> = {
  list_rack_instances: listRackInstances,
  select_rack_instance: selectRackInstance,
  get_rack_status: getRackStatus,
  acquire_writer_lease: acquireWriterLease,
  release_writer_lease: releaseWriterLease,
  list_installed_models: listInstalledModels,
  inspect_model: inspectModel,
  get_patch_snapshot: getPatchSnapshot,
  inspect_module: inspectModule,
  inspect_parameter: inspectParameter,
  describe_patch: describePatch,
  validate_patch: validatePatch,
  // Mutation, files, telemetry.
  preview_patch_transaction: previewPatchTransaction,
  commit_patch_transaction: commitPatchTransaction,
  undo_last_mcp_transaction: undoLastMcpTransaction,
  build_patch: buildPatch,
  build_recipe: buildRecipe,
  list_patch_files: listPatchFiles,
  create_checkpoint: createCheckpoint,
  save_patch: savePatch,
  preview_load_patch: previewLoadPatch,
  commit_load_patch: commitLoadPatch,
  preview_clear_patch: previewClearPatch,
  commit_clear_patch: commitClearPatch,
  restore_checkpoint: restoreCheckpoint,
  list_probes: listProbes,
  preview_attach_probe: previewAttachProbe,
  commit_attach_probe: commitAttachProbe,
  read_probe: readProbe,
  read_user_notes: readUserNotes,
  post_chat_message: postChatMessage,
  detach_probe: detachProbe,
};

export interface RegisteredTool {
  spec: ToolSpec;
  handler: ToolHandler;
  inputShape: z.ZodRawShape;
}

/** Builds the ordered tool table with input shapes for MCP registration. */
export function buildToolTable(): RegisteredTool[] {
  return TOOLS.map((spec) => {
    const handler = HANDLERS[spec.name];
    if (!handler) throw new Error(`no handler for tool ${spec.name}`);
    const shape = (spec.input as z.ZodObject<z.ZodRawShape>).shape;
    return { spec, handler, inputShape: shape };
  });
}

export const RESULT_LIMIT_BYTES = LIMITS.mcpResultBytes;
export { getTool };
