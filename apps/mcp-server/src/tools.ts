import { z } from "zod";
import { getTool, TOOLS, type ToolSpec, LIMITS } from "@rackmcp/schemas";
import { getAdapter, hasAdapter } from "@rackmcp/adapters";
import type { ConnectionManager } from "./connection.js";
import { ToolError } from "./errors.js";
import { randomUUID } from "node:crypto";
import { TransactionManager } from "./transactions.js";

/** Everything a tool handler needs. */
export interface ToolContext {
  conn: ConnectionManager;
  txns: TransactionManager;
  serverVersion: string;
  bridgeProtocolVersion: number;
}

export type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;

/** Bridge methods not yet implemented in the current plugin phase. */
function pending(tool: string): ToolHandler {
  return async () => {
    throw new ToolError(
      "UNSUPPORTED_OPERATION",
      `${tool} is not yet available in this build (its plugin-side handler ships in a later phase)`,
      false,
    );
  };
}

// ---------------------------------------------------------------------------
// Connection and discovery
// ---------------------------------------------------------------------------

const listRackInstances: ToolHandler = async (_args, ctx) => {
  const found = ctx.conn.listInstances();
  const selectedId = ctx.conn.selectedInstance?.instanceId ?? null;
  return {
    discoveryDir: (ctx.conn as unknown as { config: { discoveryDir: string } }).config?.discoveryDir ?? "",
    instances: found.map((i) => ({
      instanceId: i.manifest.instanceId,
      pid: i.manifest.pid,
      rackVersion: i.manifest.rackVersion,
      rackEdition: i.manifest.rackEdition,
      bridgeVersion: i.manifest.bridgeVersion,
      port: i.manifest.port,
      startTime: i.manifest.startTime,
      lastHeartbeat: i.manifest.lastHeartbeat,
      mode: i.manifest.mode,
      patchName: i.manifest.patchName,
      commandPumpPresent: i.manifest.commandPumpPresent,
      bridgeModulePresent: i.manifest.bridgeModulePresent,
      stale: i.stale,
      selected: i.manifest.instanceId === selectedId,
    })),
  };
};

const selectRackInstance: ToolHandler = async (args, ctx) => {
  const instanceId = args.instanceId as string;
  await ctx.conn.select(instanceId);
  const status = await ctx.conn.request<Record<string, unknown>>("status.get", {});
  return { status: mapStatus(status), connected: true as const };
};

function mapStatus(s: Record<string, unknown>): Record<string, unknown> {
  return {
    instanceId: s.instanceId,
    sessionId: s.sessionId,
    patchEpoch: s.patchEpoch,
    rackVersion: s.rackVersion,
    rackEdition: s.rackEdition,
    bridgeVersion: s.bridgeVersion,
    mode: s.mode,
    sampleRate: s.sampleRate,
    patchName: s.patchName ?? null,
    saved: s.saved,
    bridgeModulePresent: s.bridgeModulePresent,
    commandPumpPresent: s.commandPumpPresent,
    writerLease: s.writerLease,
  };
}

const getRackStatus: ToolHandler = async (_args, ctx) => {
  const selected = ctx.conn.selectedInstance;
  if (!selected || !ctx.conn.connected) {
    return {
      status: null,
      connected: false,
      selectedInstanceId: selected?.instanceId ?? null,
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
  const res = await ctx.conn.request<{
    items: unknown[];
    total: number;
    nextCursor: string | null;
  }>("catalog.listModels", {
    cursor: args.cursor,
    limit: args.limit ?? 100,
    query: args.query,
  });
  return { models: res.items, total: res.total, nextCursor: res.nextCursor };
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

const buildPatch: ToolHandler = async (args, ctx) => {
  const instance = await ctx.conn.ensureConnected();
  const { preview, confirmation } = await ctx.txns.preview(
    args.label as string,
    args.operations as unknown[],
    instance,
    { patchEpoch: args.expectedPatchEpoch as number | undefined },
  );
  const autoCommit = (args.autoCommit as boolean | undefined) ?? true;
  // Never bypass confirmation: risky plans stop at the preview with a token.
  if (!autoCommit || confirmation.confirmationRequired) {
    return { phase: "previewed" as const, preview, confirmation };
  }
  const commit = await ctx.txns.commit({
    operationId: args.operationId as string,
    planHash: preview.planHash,
    expectedFingerprint: preview.baseFingerprint,
    instance,
  });
  return { phase: "committed" as const, preview, confirmation, commit };
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
  // Mutation, files, telemetry: plugin handlers ship in later phases.
  preview_patch_transaction: previewPatchTransaction,
  commit_patch_transaction: commitPatchTransaction,
  undo_last_mcp_transaction: undoLastMcpTransaction,
  build_patch: buildPatch,
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
