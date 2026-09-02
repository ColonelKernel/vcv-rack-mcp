import { randomUUID } from "node:crypto";
import { LIMITS } from "@rackmcp/schemas";
import type { SelectedInstance } from "./connection.js";
import { ToolError } from "./errors.js";
import type { ToolContext, ToolHandler } from "./tools.js";

/**
 * Telemetry tools (spec section 8). Signal monitoring is available only via an
 * explicit Probe cable: attach/detach build transactions through the same
 * preview/commit machinery, so the graph change is auditable and reversible.
 */

interface Snapshot {
  modules: Array<{
    moduleId: string;
    isProbe: boolean;
    inputs: Array<{ portId: number; connected: boolean }>;
  }>;
  cables: Array<{ cableId: string; inputModuleId: string; inputId: number }>;
}

// Attach metadata cached between preview and commit, keyed by plan hash.
interface AttachMeta {
  probeModuleId: string | null; // null until an added probe's id is known
  probeAlias: string | null;
  probeInputId: number;
  addsProbeModule: boolean;
}
const ATTACH_META = new Map<string, AttachMeta>();

function scopeFor(instance: SelectedInstance) {
  return { instanceId: instance.instanceId, sessionId: instance.sessionId, patchEpoch: 0 };
}

async function snapshot(ctx: ToolContext): Promise<Snapshot> {
  return ctx.conn.request<Snapshot>("patch.snapshot", { includeOpaqueState: false });
}

const PROBE_INPUTS = 8;

export const listProbes: ToolHandler = async (_args, ctx) => {
  const list = await ctx.conn.request<{ slots: Array<Record<string, unknown>> }>("probe.list", {});
  const attachedCount = list.slots.filter((s) => s.connected === true).length;
  return {
    slots: list.slots,
    attachedCount,
    maxActiveProbes: LIMITS.maxActiveProbes,
  };
};

export const readProbe: ToolHandler = async (args, ctx) => {
  return ctx.conn.request("probe.read", {
    scope: scopeFor(await ctx.conn.ensureConnected()),
    probeModuleId: args.probeModuleId,
    probeInputId: args.probeInputId,
  });
};

/** Chooses a probe slot: explicit, an existing free slot, or a new module. */
function chooseSlot(
  snap: Snapshot,
  explicit: { probeModuleId: string; probeInputId: number } | undefined,
): AttachMeta {
  if (explicit) {
    return {
      probeModuleId: explicit.probeModuleId,
      probeAlias: null,
      probeInputId: explicit.probeInputId,
      addsProbeModule: false,
    };
  }
  const probes = snap.modules.filter((m) => m.isProbe);
  for (const probe of probes) {
    for (let i = 0; i < PROBE_INPUTS; i++) {
      const input = probe.inputs.find((p) => p.portId === i);
      if (input && !input.connected) {
        return {
          probeModuleId: probe.moduleId,
          probeAlias: null,
          probeInputId: i,
          addsProbeModule: false,
        };
      }
    }
  }
  return { probeModuleId: null, probeAlias: "rackmcp_probe", probeInputId: 0, addsProbeModule: true };
}

export const previewAttachProbe: ToolHandler = async (args, ctx) => {
  const instance = await ctx.conn.ensureConnected();
  const source = args.source as { module: { moduleId: string }; portType: string; portId: number };
  const explicit = args.probe as { probeModuleId: string; probeInputId: number } | undefined;
  const snap = await snapshot(ctx);
  const slot = chooseSlot(snap, explicit);

  const probesActive = snap.modules.filter((m) => m.isProbe).length;
  if (slot.addsProbeModule && probesActive >= LIMITS.maxActiveProbes) {
    throw new ToolError("TELEMETRY_UNAVAILABLE", `probe limit (${LIMITS.maxActiveProbes}) reached`);
  }

  const operations: unknown[] = [];
  const probeModuleRef = slot.addsProbeModule
    ? { alias: slot.probeAlias! }
    : { moduleId: slot.probeModuleId! };
  if (slot.addsProbeModule) {
    operations.push({
      op: "add_module",
      pluginSlug: "RackMCP",
      modelSlug: "Probe",
      alias: slot.probeAlias!,
      placement: "auto",
    });
  }
  operations.push({
    op: "connect",
    output: { module: { moduleId: source.module.moduleId }, portType: "output", portId: source.portId },
    input: { module: probeModuleRef, portType: "input", portId: slot.probeInputId },
    inputPolicy: "replace_all",
    color: "#2a7fc8",
  });

  const { preview, confirmation } = await ctx.txns.preview("Attach probe", operations, instance);
  ATTACH_META.set(preview.planHash, slot);
  return {
    preview,
    confirmation,
    slot: {
      probeModuleId: slot.probeModuleId,
      probeInputId: slot.probeInputId,
      addsProbeModule: slot.addsProbeModule,
    },
  };
};

export const commitAttachProbe: ToolHandler = async (args, ctx) => {
  const instance = await ctx.conn.ensureConnected();
  const meta = ATTACH_META.get(args.planHash as string);
  const commit = (await ctx.txns.commit({
    operationId: args.operationId as string,
    planHash: args.planHash as string,
    expectedFingerprint: args.expectedFingerprint as string,
    confirmationToken: args.confirmationToken as string | undefined,
    instance,
  })) as { aliasToModuleId: Record<string, string> };

  let probeModuleId = meta?.probeModuleId ?? null;
  if (!probeModuleId && meta?.probeAlias) {
    probeModuleId = commit.aliasToModuleId[meta.probeAlias] ?? null;
  }
  const probeInputId = meta?.probeInputId ?? 0;
  ATTACH_META.delete(args.planHash as string);

  // Resolve the created cable id from a fresh snapshot.
  let cableId = "";
  if (probeModuleId) {
    const snap = await snapshot(ctx);
    const cable = snap.cables.find(
      (c) => c.inputModuleId === probeModuleId && c.inputId === probeInputId,
    );
    cableId = cable?.cableId ?? "";
  }
  return { commit, probeModuleId: probeModuleId ?? "", probeInputId, cableId };
};

export const detachProbe: ToolHandler = async (args, ctx) => {
  const instance = await ctx.conn.ensureConnected();
  const probeModuleId = args.probeModuleId as string;
  const probeInputId = args.probeInputId as number;

  // Which cables feed this probe input (for the removedCableIds report)?
  const before = await snapshot(ctx);
  const removed = before.cables
    .filter((c) => c.inputModuleId === probeModuleId && c.inputId === probeInputId)
    .map((c) => c.cableId);

  const operations = [
    {
      op: "disconnect_port",
      port: { module: { moduleId: probeModuleId }, portType: "input", portId: probeInputId },
      policy: "all",
    },
  ];
  const { preview } = await ctx.txns.preview("Detach probe", operations, instance);
  const commit = (await ctx.txns.commit({
    operationId: args.operationId as string,
    planHash: preview.planHash,
    expectedFingerprint: preview.baseFingerprint,
    instance,
  })) as { newFingerprint: string; replayed: boolean };

  return {
    detached: true as const,
    removedCableIds: removed,
    newFingerprint: commit.newFingerprint,
    replayed: commit.replayed,
  };
};
