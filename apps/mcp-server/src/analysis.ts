import { getAdapter, hasAdapter } from "@rackmcp/adapters";
import type { SignalRole } from "@rackmcp/adapters";
import type { ToolContext, ToolHandler } from "./tools.js";

/**
 * Server-side patch analysis over a snapshot: signal-flow description and
 * structural validation (spec section 10). Findings carry a confidence:
 *   - "certain"   : pure graph/state structure, always true
 *   - "adapter"   : depends on verified adapter semantics
 *   - "heuristic" : name/shape inference that may be wrong
 * Per the spec, cycles are never inherently invalid and a role/name mismatch is
 * never proof of incompatibility; such observations are surfaced as advisory
 * info, never as errors.
 */

interface Snapshot {
  modules: ModuleS[];
  cables: CableS[];
  bridgeModuleCount: number;
  patchEpoch: number;
}
interface PortS {
  portId: number;
  name: string;
  connected: boolean;
  channels: number;
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
  inputs: PortS[];
  outputs: PortS[];
  gridPosition: { x: number; y: number } | null;
  gridWidth: number | null;
  expanders?: { left: string | null; right: string | null };
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

/** Coarse signal family used only to surface audio<->control cross-patching. */
type Family = "audio" | "control";
function familyOf(role: SignalRole | undefined): Family | undefined {
  if (role === "audio") return "audio";
  if (
    role === "cv_unipolar" ||
    role === "cv_bipolar" ||
    role === "pitch_voct" ||
    role === "gate" ||
    role === "trigger" ||
    role === "clock"
  ) {
    return "control";
  }
  return undefined; // unknown / unadaptered -> no opinion
}

function outputRoleOf(m: ModuleS, portId: number): SignalRole | undefined {
  return getAdapter(m.pluginSlug, m.modelSlug)?.outputs.find((p) => p.portId === portId)?.role;
}
function inputRoleOf(m: ModuleS, portId: number): SignalRole | undefined {
  return getAdapter(m.pluginSlug, m.modelSlug)?.inputs.find((p) => p.portId === portId)?.role;
}
function inputPolyphonyOf(m: ModuleS, portId: number): string | undefined {
  return getAdapter(m.pluginSlug, m.modelSlug)?.inputs.find((p) => p.portId === portId)?.polyphony;
}

/** Modules from which signal can reach an audio destination (reverse reachability). */
function modulesFeedingDestinations(snap: Snapshot): Set<string> {
  const incoming = new Map<string, CableS[]>();
  for (const c of snap.cables) {
    const list = incoming.get(c.inputModuleId);
    if (list) list.push(c);
    else incoming.set(c.inputModuleId, [c]);
  }
  const reached = new Set<string>();
  const stack = snap.modules.filter(isAudioDestination).map((m) => m.moduleId);
  while (stack.length) {
    const id = stack.pop()!;
    if (reached.has(id)) continue;
    reached.add(id);
    for (const c of incoming.get(id) ?? []) stack.push(c.outputModuleId);
  }
  return reached;
}

/**
 * Modules that participate in a directed feedback cycle (self-loop or a
 * strongly-connected component of size > 1), via iterative Tarjan SCC.
 */
function modulesInCycles(snap: Snapshot): Set<string> {
  const adj = new Map<string, string[]>();
  for (const m of snap.modules) adj.set(m.moduleId, []);
  const selfLoop = new Set<string>();
  for (const c of snap.cables) {
    if (c.outputModuleId === c.inputModuleId) selfLoop.add(c.outputModuleId);
    adj.get(c.outputModuleId)?.push(c.inputModuleId);
  }
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const tstack: string[] = [];
  const inCycle = new Set<string>(selfLoop);
  let counter = 0;

  for (const start of adj.keys()) {
    if (index.has(start)) continue;
    // Iterative DFS frame: node + child cursor.
    const work: Array<{ v: string; i: number }> = [{ v: start, i: 0 }];
    index.set(start, counter);
    low.set(start, counter);
    counter++;
    tstack.push(start);
    onStack.add(start);
    while (work.length) {
      const frame = work[work.length - 1]!;
      const neighbors = adj.get(frame.v) ?? [];
      if (frame.i < neighbors.length) {
        const w = neighbors[frame.i++]!;
        if (!index.has(w)) {
          index.set(w, counter);
          low.set(w, counter);
          counter++;
          tstack.push(w);
          onStack.add(w);
          work.push({ v: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(frame.v, Math.min(low.get(frame.v)!, index.get(w)!));
        }
      } else {
        if (low.get(frame.v) === index.get(frame.v)) {
          const comp: string[] = [];
          let w: string;
          do {
            w = tstack.pop()!;
            onStack.delete(w);
            comp.push(w);
          } while (w !== frame.v);
          if (comp.length > 1) for (const c of comp) inCycle.add(c);
        }
        work.pop();
        const parent = work[work.length - 1];
        if (parent) low.set(parent.v, Math.min(low.get(parent.v)!, low.get(frame.v)!));
      }
    }
  }
  return inCycle;
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

  const unknownModuleCount = snap.modules.filter((m) => !hasAdapter(m.pluginSlug, m.modelSlug)).length;

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
    unknownModuleCount > 0 ? `${unknownModuleCount} module(s) without a verified adapter, described heuristically.` : "",
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
  const cablesByInputPort = new Map<string, CableS[]>();
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

    const inKey = `${c.inputModuleId}:${c.inputId}`;
    const list = cablesByInputPort.get(inKey);
    if (list) list.push(c);
    else cablesByInputPort.set(inKey, [c]);
  }

  // Multiple cables into one input port: Rack keeps one connection per input, so
  // stacked inputs are summed/replaced depending on how they were created.
  for (const [inKey, list] of cablesByInputPort) {
    if (list.length > 1) {
      const [modId, portId] = inKey.split(":");
      const m = byId.get(modId!);
      add("inputs.stacked", "info", "certain",
        `Input port ${portId} of ${m?.modelName ?? modId} has ${list.length} cables; unless a summing/merge is in place, only one connection is effective.`,
        list.map((c) => ({ type: "cable", cableId: c.cableId })),
        "Use a mixer or Merge module to combine multiple sources into one input.");
    }
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

  // Expander adjacency consistency: when a module reports an expander neighbor,
  // that neighbor should exist and sit immediately beside it on the same row.
  for (const m of snap.modules) {
    const leftId = m.expanders?.left ?? null;
    if (leftId && m.gridPosition) {
      const l = byId.get(leftId);
      const ok = !!l && !!l.gridPosition && !!l.gridWidth &&
        l.gridPosition.y === m.gridPosition.y &&
        l.gridPosition.x + l.gridWidth === m.gridPosition.x;
      if (!ok) {
        add("expander.adjacency", "info", "certain",
          `${m.modelName} reports a left expander (${leftId}) that is not immediately adjacent on the same row.`,
          [{ type: "module", moduleId: m.moduleId }],
          "Place expander modules directly next to their host, on the same row, with no gap.");
      }
    }
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

  // Bypassed modules mid-path (confidence heuristic: bypass pass-through is
  // module-defined and not visible in the snapshot).
  const feeds = modulesFeedingDestinations(snap);
  for (const m of snap.modules) {
    if (!m.bypassed) continue;
    const hasIncoming = m.inputs.some((p) => p.connected);
    const hasOutgoing = m.outputs.some((p) => p.connected);
    if (feeds.has(m.moduleId) && hasIncoming && hasOutgoing) {
      add("bypass.interruptsPath", "warning", "heuristic",
        `${m.modelName} is bypassed while on a signal path to an audio output; unless it defines a bypass pass-through, downstream signal is interrupted.`,
        [{ type: "module", moduleId: m.moduleId }],
        "Un-bypass the module, or route around it, to restore the signal path.");
    }
  }

  // Feedback cycles are informational, never invalid (spec section 10).
  const cycles = modulesInCycles(snap);
  if (cycles.size > 0) {
    add("cycle.feedback", "info", "certain",
      `The patch contains a feedback loop involving ${cycles.size} module(s). This is often intentional; verify levels to avoid runaway feedback.`,
      [...cycles].slice(0, 64).map((id) => ({ type: "module", moduleId: id })));
  }

  // --- Adapter-backed advisory checks (confidence: adapter) ---
  for (const c of snap.cables) {
    const out = byId.get(c.outputModuleId);
    const inp = byId.get(c.inputModuleId);
    if (!out || !inp) continue;
    if (c.outputId >= out.outputs.length || c.inputId >= inp.inputs.length) continue;

    const oRole = outputRoleOf(out, c.outputId);
    const iRole = inputRoleOf(inp, c.inputId);
    const oFam = familyOf(oRole);
    const iFam = familyOf(iRole);
    // Only flag a clear audio<->control cross where both roles are known.
    if (oFam && iFam && oFam !== iFam) {
      add("adapter.signalRoleCross", "info", "adapter",
        `${out.modelName} ${oRole} output feeds ${inp.modelName} ${iRole} input (audio↔control). This may be intentional (e.g. audio-rate modulation), but check it is deliberate.`,
        [{ type: "cable", cableId: c.cableId }]);
    }

    // Polyphonic signal into an adapter-declared monophonic input.
    const outChannels = out.outputs[c.outputId]?.channels ?? 0;
    if (outChannels > 1 && inputPolyphonyOf(inp, c.inputId) === "monophonic") {
      add("adapter.polyIntoMono", "info", "adapter",
        `A ${outChannels}-channel polyphonic signal from ${out.modelName} enters ${inp.modelName}'s monophonic input; channels beyond the first are summed or dropped.`,
        [{ type: "cable", cableId: c.cableId }],
        "Insert a Merge/Sum or mix the voices before this monophonic input if summing is intended.");
    }
  }

  // Third-party modules without a verified adapter are interpreted heuristically.
  const unadaptered = snap.modules.filter((m) => !hasAdapter(m.pluginSlug, m.modelSlug));
  if (unadaptered.length > 0) {
    add("adapter.unverifiedModules", "info", "heuristic",
      `${unadaptered.length} module(s) have no verified adapter; their semantics are inferred and any role-based findings about them are heuristic.`,
      unadaptered.slice(0, 64).map((m) => ({ type: "module", moduleId: m.moduleId })));
  }

  // --- Silence heuristics ---
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
