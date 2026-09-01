import type { ToolContext, ToolHandler } from "./tools.js";

/**
 * Server-side patch analysis over a snapshot: signal-flow description and
 * structural validation. Semantic/advisory checks that need adapters ship
 * with the adapter pack (spec section 10); everything here is confidence
 * "certain" (pure graph structure) or "heuristic" (name-based).
 */

interface Snapshot {
  modules: ModuleS[];
  cables: CableS[];
  bridgeModuleCount: number;
  patchEpoch: number;
}
interface ModuleS {
  moduleId: string;
  modelName: string;
  modelSlug: string;
  pluginSlug: string;
  bypassed: boolean;
  isBridge: boolean;
  isProbe: boolean;
  params: Array<{ paramId: number; value: number; minValue: number | null; maxValue: number | null; name: string }>;
  inputs: Array<{ portId: number; name: string; connected: boolean; channels: number }>;
  outputs: Array<{ portId: number; name: string; connected: boolean; channels: number }>;
  gridPosition: { x: number; y: number } | null;
  gridWidth: number | null;
}
interface CableS {
  cableId: string;
  outputModuleId: string;
  outputId: number;
  inputModuleId: string;
  inputId: number;
}

async function snapshot(ctx: ToolContext, expectedPatchEpoch?: number): Promise<Snapshot> {
  return ctx.conn.request<Snapshot>("patch.snapshot", { includeOpaqueState: false, expectedPatchEpoch });
}

function isAudioDestination(m: ModuleS): boolean {
  return m.pluginSlug === "Core" && /audio/i.test(m.modelSlug);
}

export const describePatch: ToolHandler = async (args, ctx) => {
  const snap = await snapshot(ctx, args.expectedPatchEpoch as number | undefined);
  const byId = new Map(snap.modules.map((m) => [m.moduleId, m]));
  const incoming = new Map<string, CableS[]>();
  for (const c of snap.cables) {
    (incoming.get(c.inputModuleId) ?? incoming.set(c.inputModuleId, []).get(c.inputModuleId)!).push(c);
  }

  // Trace back from each audio destination to its sources.
  const chains: Array<{ description: string; moduleIds: string[]; confidence: string }> = [];
  const destinations = snap.modules.filter(isAudioDestination);
  for (const dest of destinations) {
    const visited = new Set<string>();
    const order: string[] = [];
    const stack = [dest.moduleId];
    while (stack.length) {
      const id = stack.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      order.push(id);
      for (const c of incoming.get(id) ?? []) stack.push(c.outputModuleId);
    }
    const names = order.map((id) => byId.get(id)?.modelName ?? id).reverse();
    chains.push({
      description: `Signal path into ${dest.modelName}: ${names.join(" → ")}`,
      moduleIds: order,
      confidence: "certain",
    });
  }

  const unknownModuleCount = snap.modules.filter(
    (m) => m.pluginSlug !== "Core" && m.pluginSlug !== "Fundamental" && m.pluginSlug !== "RackMCP",
  ).length;

  const warnings: string[] = [];
  if (destinations.length === 0) {
    warnings.push("No Core Audio destination module found; the patch produces no audio output.");
  }
  if (snap.bridgeModuleCount === 0) {
    warnings.push("No RackMCP-Bridge module: this patch cannot reconnect after a Rack restart.");
  }

  const summaryParts = [
    `${snap.modules.length} modules, ${snap.cables.length} cables.`,
    destinations.length > 0
      ? `${destinations.length} audio destination(s).`
      : "No audio destination.",
    unknownModuleCount > 0 ? `${unknownModuleCount} third-party module(s) described heuristically.` : "",
  ].filter(Boolean);

  return {
    summary: summaryParts.join(" "),
    moduleCount: snap.modules.length,
    cableCount: snap.cables.length,
    chains,
    unknownModuleCount,
    warnings,
  };
};

export const validatePatch: ToolHandler = async (args, ctx) => {
  const snap = await snapshot(ctx, args.expectedPatchEpoch as number | undefined);
  const byId = new Map(snap.modules.map((m) => [m.moduleId, m]));
  const findings: Array<Record<string, unknown>> = [];

  const add = (
    ruleId: string,
    severity: "error" | "warning" | "info",
    confidence: "certain" | "adapter" | "heuristic",
    explanation: string,
    entities: Array<Record<string, unknown>>,
    suggestion?: string,
  ) => {
    findings.push({ ruleId, severity, confidence, explanation, entities, suggestion: suggestion ?? null });
  };

  // --- Structural checks (confidence: certain) ---

  // Cable endpoints must resolve; port indices in bounds; direction correct.
  const seenCablePairs = new Set<string>();
  for (const c of snap.cables) {
    const out = byId.get(c.outputModuleId);
    const inp = byId.get(c.inputModuleId);
    if (!out || !inp) {
      add("cable.dangling", "error", "certain", `Cable ${c.cableId} references a missing module.`, [
        { type: "cable", cableId: c.cableId },
      ]);
      continue;
    }
    if (c.outputId < 0 || c.outputId >= out.outputs.length) {
      add("port.outOfBounds", "error", "certain",
        `Cable ${c.cableId} output port ${c.outputId} is out of bounds for ${out.modelName}.`,
        [{ type: "cable", cableId: c.cableId }]);
    }
    if (c.inputId < 0 || c.inputId >= inp.inputs.length) {
      add("port.outOfBounds", "error", "certain",
        `Cable ${c.cableId} input port ${c.inputId} is out of bounds for ${inp.modelName}.`,
        [{ type: "cable", cableId: c.cableId }]);
    }
    const key = `${c.outputModuleId}:${c.outputId}->${c.inputModuleId}:${c.inputId}`;
    if (seenCablePairs.has(key)) {
      add("cable.duplicate", "warning", "certain",
        `Duplicate identical cable between the same ports (${key}).`,
        [{ type: "cable", cableId: c.cableId }], "Remove the redundant cable.");
    }
    seenCablePairs.add(key);
  }

  // Position collisions.
  const posSeen = new Map<string, string>();
  for (const m of snap.modules) {
    if (!m.gridPosition) continue;
    const key = `${m.gridPosition.x},${m.gridPosition.y}`;
    if (posSeen.has(key)) {
      add("module.collision", "warning", "certain",
        `Modules ${posSeen.get(key)} and ${m.moduleId} share grid position ${key}.`,
        [{ type: "module", moduleId: m.moduleId }]);
    }
    posSeen.set(key, m.moduleId);
  }

  // Parameter range + finiteness.
  for (const m of snap.modules) {
    for (const p of m.params) {
      if (!Number.isFinite(p.value)) {
        add("param.nonFinite", "error", "certain",
          `${m.modelName} param "${p.name}" has a non-finite value.`,
          [{ type: "parameter", moduleId: m.moduleId, paramId: p.paramId }]);
      } else if (p.minValue !== null && p.maxValue !== null && (p.value < p.minValue - 1e-4 || p.value > p.maxValue + 1e-4)) {
        add("param.outOfRange", "warning", "certain",
          `${m.modelName} param "${p.name}" value ${p.value} is outside [${p.minValue}, ${p.maxValue}].`,
          [{ type: "parameter", moduleId: m.moduleId, paramId: p.paramId }]);
      }
    }
  }

  // Bridge persistence.
  if (snap.bridgeModuleCount === 0) {
    add("bridge.missing", "warning", "certain",
      "The patch has no RackMCP-Bridge module and will not reconnect after a Rack restart.",
      [], "Add a RackMCP-Bridge module before saving a patch you intend to reconnect to.");
  }

  // --- Advisory checks (confidence: heuristic) ---
  const audioDest = snap.modules.filter(isAudioDestination);
  if (audioDest.length > 0) {
    const anyConnected = audioDest.some((m) => m.inputs.some((p) => p.connected));
    if (!anyConnected) {
      add("audio.noInput", "warning", "heuristic",
        "An audio destination exists but has no connected inputs; the patch is likely silent.",
        audioDest.map((m) => ({ type: "module", moduleId: m.moduleId })),
        "Connect a signal source to the audio module's inputs.");
    }
  } else {
    add("audio.noDestination", "info", "heuristic",
      "No Core Audio destination module found; the patch produces no audible output.", []);
  }

  const errorCount = findings.filter((f) => f.severity === "error").length;
  const warningCount = findings.filter((f) => f.severity === "warning").length;
  return {
    findings,
    errorCount,
    warningCount,
    infoCount: findings.length - errorCount - warningCount,
    valid: errorCount === 0,
    patchEpoch: snap.patchEpoch,
  };
};
