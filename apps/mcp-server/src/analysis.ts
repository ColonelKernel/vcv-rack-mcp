import { getAdapter, hasAdapter, paramSemantics } from "@rackmcp/adapters";
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
  params: Array<{ paramId: number; value: number | null; minValue: number | null; maxValue: number | null; name: string }>;
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

/** Control sub-family, used to surface pitch/gate confusion (spec section 10). */
type ControlKind = "pitch" | "event";
function controlKindOf(role: SignalRole | undefined): ControlKind | undefined {
  if (role === "pitch_voct") return "pitch";
  if (role === "gate" || role === "trigger" || role === "clock") return "event";
  return undefined;
}

/**
 * The longest real cable path ending at `dest`, as module IDs from source to
 * destination. Every consecutive pair is an actual cable, so a description
 * built from this never implies a connection that does not exist. Edges that
 * would close a cycle are skipped, so a feedback patch still yields a real (if
 * not maximal) path. Iterative to keep deep patches off the JS stack.
 */
function longestCablePathTo(dest: string, incoming: Map<string, CableS[]>): string[] {
  const memo = new Map<string, string[]>();
  const onStack = new Set<string>([dest]);
  const work: Array<{ id: string; i: number; best: string[] }> = [{ id: dest, i: 0, best: [] }];
  while (work.length) {
    const frame = work[work.length - 1]!;
    const cables = incoming.get(frame.id) ?? [];
    if (frame.i < cables.length) {
      const src = cables[frame.i++]!.outputModuleId;
      if (onStack.has(src)) continue; // would close a cycle
      const cached = memo.get(src);
      if (cached) {
        // A memoized path from another branch may already contain this node;
        // reusing it would repeat a module, so only take acyclic candidates.
        if (cached.length > frame.best.length && !cached.includes(frame.id)) frame.best = cached;
        continue;
      }
      onStack.add(src);
      work.push({ id: src, i: 0, best: [] });
    } else {
      const path = frame.best.concat([frame.id]);
      memo.set(frame.id, path);
      onStack.delete(frame.id);
      work.pop();
      const parent = work[work.length - 1];
      if (parent && path.length > parent.best.length && !path.includes(parent.id)) parent.best = path;
    }
  }
  return memo.get(dest) ?? [dest];
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

  // Trace back from each audio destination to its sources. The headline chain
  // is a real cable path (every arrow is an actual cable); everything else that
  // feeds the destination is reported as explicit edges rather than being
  // flattened into the same arrow string, which would imply connections that do
  // not exist.
  const chains: Array<{ description: string; moduleIds: string[]; confidence: string }> = [];
  const destinations = snap.modules.filter(isAudioDestination);
  const nameOf = (id: string) => byId.get(id)?.modelName ?? id;
  for (const dest of destinations) {
    // Every module that can reach this destination.
    const ancestors = new Set<string>();
    const stack = [dest.moduleId];
    while (stack.length) {
      const id = stack.pop()!;
      if (ancestors.has(id)) continue;
      ancestors.add(id);
      for (const c of incoming.get(id) ?? []) stack.push(c.outputModuleId);
    }

    const path = longestCablePathTo(dest.moduleId, incoming);
    const onPath = new Set<string>();
    for (let i = 1; i < path.length; i++) onPath.add(`${path[i - 1]}->${path[i]}`);

    // Remaining real edges within the feeding subgraph, de-duplicated by
    // module pair (two cables between the same modules are one relationship).
    const extras: Array<[string, string]> = [];
    const seenPair = new Set<string>(onPath);
    for (const c of snap.cables) {
      if (!ancestors.has(c.outputModuleId) || !ancestors.has(c.inputModuleId)) continue;
      const key = `${c.outputModuleId}->${c.inputModuleId}`;
      if (seenPair.has(key)) continue;
      seenPair.add(key);
      extras.push([c.outputModuleId, c.inputModuleId]);
    }

    const moduleIds = path.slice();
    let description = `Signal path into ${dest.modelName}: ${path.map(nameOf).join(" → ")}`;
    if (extras.length > 0) {
      const shown: string[] = [];
      for (const [from, to] of extras) {
        // Keep the description within the schema's 1024-character cap.
        const clause = `${nameOf(from)} → ${nameOf(to)}`;
        if (description.length + shown.join(", ").length + clause.length + 24 > 1000) {
          shown.push(`and ${extras.length - shown.length} more`);
          break;
        }
        shown.push(clause);
        for (const id of [from, to]) if (!moduleIds.includes(id)) moduleIds.push(id);
      }
      description += `; also feeding it: ${shown.join(", ")}`;
    }
    chains.push({
      // Every claim above is a cable that exists in the snapshot.
      description,
      moduleIds: moduleIds.slice(0, 256),
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

/** Mirrors the EntityRef discriminated union in packages/schemas. */
type EntityRef =
  | { kind: "module"; moduleId: string }
  | { kind: "cable"; cableId: string }
  | { kind: "port"; moduleId: string; portType: "input" | "output"; portId: number }
  | { kind: "param"; moduleId: string; paramId: number }
  | { kind: "patch" };

/**
 * Every rule `validatePatch` evaluates, in report order. Returned verbatim as
 * the report's `rulesRun` so a caller can distinguish "checked, nothing found"
 * from "never checked" — the adapter-backed rules in particular stay silent on
 * modules with no adapter, and silence alone does not mean clean.
 *
 * Kept in lockstep with the `add(...)` calls below by a test that reads this
 * source file, so a new rule cannot ship without appearing here.
 */
export const VALIDATION_RULES = [
  "cable.dangling",
  "port.out_of_bounds",
  "cable.duplicate",
  "inputs.stacked",
  "module.collision",
  "expander.adjacency",
  "param.non_finite",
  "param.out_of_range",
  "param.outside_safe_range",
  "bridge.missing",
  "bypass.interrupts_path",
  "cycle.feedback",
  "adapter.signal_role_cross",
  "adapter.pitch_gate_confusion",
  "adapter.poly_into_mono",
  "adapter.unverified_modules",
  "audio.no_input",
  "audio.no_destination",
] as const;

export const validatePatch: ToolHandler = async (args, ctx) => {
  const snap = await snapshot(ctx, args.expectedPatchEpoch as number | undefined);
  const byId = new Map(snap.modules.map((m) => [m.moduleId, m]));
  const findings: Array<Record<string, unknown>> = [];

  /**
   * Append one finding in the exact ValidationFinding shape
   * (packages/schemas/src/validation.ts): entity refs discriminated on `kind`,
   * a required `evidence` record carrying the machine-checkable facts behind
   * the claim, and `suggestedRepair` omitted rather than nulled when there is
   * no repair to suggest.
   */
  const add = (
    ruleId: string,
    severity: "error" | "warning" | "info",
    confidence: "certain" | "adapter" | "heuristic",
    explanation: string,
    entities: EntityRef[],
    evidence: Record<string, unknown>,
    suggestedRepair?: string,
  ) => {
    findings.push({
      ruleId,
      severity,
      confidence,
      entities,
      evidence,
      explanation,
      ...(suggestedRepair !== undefined ? { suggestedRepair } : {}),
    });
  };

  // --- Structural checks (confidence: certain) ---

  // Cable endpoints must resolve; port indices in bounds; direction correct.
  const seenCablePairs = new Set<string>();
  const cablesByInputPort = new Map<string, CableS[]>();
  for (const c of snap.cables) {
    const out = byId.get(c.outputModuleId);
    const inp = byId.get(c.inputModuleId);
    if (!out || !inp) {
      add("cable.dangling", "error", "certain", `Cable ${c.cableId} references a missing module.`,
        [{ kind: "cable", cableId: c.cableId }],
        {
          cableId: c.cableId,
          outputModuleId: c.outputModuleId,
          inputModuleId: c.inputModuleId,
          missingEndpoint: !out ? "output" : "input",
        });
      continue;
    }
    if (c.outputId < 0 || c.outputId >= out.outputs.length) {
      add("port.out_of_bounds", "error", "certain",
        `Cable ${c.cableId} output port ${c.outputId} is out of bounds for ${out.modelName}.`,
        [{ kind: "port", moduleId: c.outputModuleId, portType: "output", portId: c.outputId }],
        { cableId: c.cableId, portType: "output", portId: c.outputId, portCount: out.outputs.length });
    }
    if (c.inputId < 0 || c.inputId >= inp.inputs.length) {
      add("port.out_of_bounds", "error", "certain",
        `Cable ${c.cableId} input port ${c.inputId} is out of bounds for ${inp.modelName}.`,
        [{ kind: "port", moduleId: c.inputModuleId, portType: "input", portId: c.inputId }],
        { cableId: c.cableId, portType: "input", portId: c.inputId, portCount: inp.inputs.length });
    }
    const key = `${c.outputModuleId}:${c.outputId}->${c.inputModuleId}:${c.inputId}`;
    if (seenCablePairs.has(key)) {
      add("cable.duplicate", "warning", "certain",
        `Duplicate identical cable between the same ports (${key}).`,
        [{ kind: "cable", cableId: c.cableId }],
        { cableId: c.cableId, endpoints: key },
        "Remove the redundant cable.");
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
        list.map((c): EntityRef => ({ kind: "cable", cableId: c.cableId })),
        {
          moduleId: modId,
          portType: "input",
          portId: Number(portId),
          cableCount: list.length,
          cableIds: list.map((c) => c.cableId),
        },
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
        [{ kind: "module", moduleId: m.moduleId }],
        { gridPosition: m.gridPosition, otherModuleId: posSeen.get(key) });
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
          [{ kind: "module", moduleId: m.moduleId }],
          {
            expanderSide: "left",
            declaredNeighborId: leftId,
            neighborPresent: !!l,
            hostPosition: m.gridPosition,
            neighborPosition: l?.gridPosition ?? null,
          },
          "Place expander modules directly next to their host, on the same row, with no gap.");
      }
    }
  }

  // Parameter range + finiteness.
  for (const m of snap.modules) {
    for (const p of m.params) {
      // null arrives when the live value is non-finite: JSON cannot carry
      // NaN/infinity, so the plugin sends null rather than dropping the key.
      const value = p.value;
      if (value === null || !Number.isFinite(value)) {
        add("param.non_finite", "error", "certain",
          `${m.modelName} param "${p.name}" has a non-finite value.`,
          [{ kind: "param", moduleId: m.moduleId, paramId: p.paramId }],
          { paramId: p.paramId, value: String(value) });
      } else if (p.minValue !== null && p.maxValue !== null && (value < p.minValue - 1e-4 || value > p.maxValue + 1e-4)) {
        add("param.out_of_range", "warning", "certain",
          `${m.modelName} param "${p.name}" value ${value} is outside [${p.minValue}, ${p.maxValue}].`,
          [{ kind: "param", moduleId: m.moduleId, paramId: p.paramId }],
          { paramId: p.paramId, value, minValue: p.minValue, maxValue: p.maxValue });
      } else {
        // Adapter-declared safe range: within the module's hard bounds but
        // outside what the verified adapter vouches for (spec section 10,
        // "excessive output level where … an adapter provides evidence").
        const safe = paramSemantics(m.pluginSlug, m.modelSlug, p.paramId)?.safeRange;
        if (safe && (value < safe[0] - 1e-4 || value > safe[1] + 1e-4)) {
          add("param.outside_safe_range", "info", "adapter",
            `${m.modelName} param "${p.name}" value ${value} is outside the adapter's safe range [${safe[0]}, ${safe[1]}]. This is legal for the module but may produce excessive levels.`,
            [{ kind: "param", moduleId: m.moduleId, paramId: p.paramId }],
            { paramId: p.paramId, value, safeRange: safe, hardRange: [p.minValue, p.maxValue] },
            `Bring the parameter back within [${safe[0]}, ${safe[1]}] unless the extreme value is deliberate.`);
        }
      }
    }
  }

  // Bridge persistence.
  if (snap.bridgeModuleCount === 0) {
    add("bridge.missing", "warning", "certain",
      "The patch has no RackMCP-Bridge module and will not reconnect after a Rack restart.",
      [{ kind: "patch" }],
      { bridgeModuleCount: snap.bridgeModuleCount },
      "Add a RackMCP-Bridge module before saving a patch you intend to reconnect to.");
  }

  // Bypassed modules mid-path (confidence heuristic: bypass pass-through is
  // module-defined and not visible in the snapshot).
  const feeds = modulesFeedingDestinations(snap);
  for (const m of snap.modules) {
    if (!m.bypassed) continue;
    const hasIncoming = m.inputs.some((p) => p.connected);
    const hasOutgoing = m.outputs.some((p) => p.connected);
    if (feeds.has(m.moduleId) && hasIncoming && hasOutgoing) {
      add("bypass.interrupts_path", "warning", "heuristic",
        `${m.modelName} is bypassed while on a signal path to an audio output; unless it defines a bypass pass-through, downstream signal is interrupted.`,
        [{ kind: "module", moduleId: m.moduleId }],
        { bypassed: true, hasIncoming, hasOutgoing, feedsAudioDestination: true },
        "Un-bypass the module, or route around it, to restore the signal path.");
    }
  }

  // Feedback cycles are informational, never invalid (spec section 10).
  const cycles = modulesInCycles(snap);
  if (cycles.size > 0) {
    add("cycle.feedback", "info", "certain",
      `The patch contains a feedback loop involving ${cycles.size} module(s). This is often intentional; verify levels to avoid runaway feedback.`,
      [...cycles].slice(0, 64).map((id): EntityRef => ({ kind: "module", moduleId: id })),
      { moduleCount: cycles.size, moduleIds: [...cycles].slice(0, 64) });
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
      add("adapter.signal_role_cross", "info", "adapter",
        `${out.modelName} ${oRole} output feeds ${inp.modelName} ${iRole} input (audio↔control). This may be intentional (e.g. audio-rate modulation), but check it is deliberate.`,
        [{ kind: "cable", cableId: c.cableId }],
        { cableId: c.cableId, outputRole: oRole, inputRole: iRole, outputFamily: oFam, inputFamily: iFam });
    }

    // Pitch/gate confusion: both roles are "control", so the audio↔control
    // check above cannot see it. A gate driving a 1V/oct input (or pitch
    // driving a gate/trigger/clock input) is usually a mistake — but it is a
    // legitimate technique too, so this stays advisory, never an error.
    const oKind = controlKindOf(oRole);
    const iKind = controlKindOf(iRole);
    if (oKind && iKind && oKind !== iKind) {
      add("adapter.pitch_gate_confusion", "info", "adapter",
        `${out.modelName}'s ${oRole} output feeds ${inp.modelName}'s ${iRole} input. Pitch (1V/oct) and gate/trigger/clock signals are rarely interchangeable; check this is deliberate.`,
        [{ kind: "cable", cableId: c.cableId }],
        { cableId: c.cableId, outputRole: oRole, inputRole: iRole, outputKind: oKind, inputKind: iKind },
        oKind === "event"
          ? "Route a 1V/oct pitch source into the pitch input, or use the gate to drive an envelope instead."
          : "Route a gate/trigger source into this input, or use a comparator to derive a gate from the pitch signal.");
    }

    // Polyphonic signal into an adapter-declared monophonic input.
    const outChannels = out.outputs[c.outputId]?.channels ?? 0;
    if (outChannels > 1 && inputPolyphonyOf(inp, c.inputId) === "monophonic") {
      add("adapter.poly_into_mono", "info", "adapter",
        `A ${outChannels}-channel polyphonic signal from ${out.modelName} enters ${inp.modelName}'s monophonic input; channels beyond the first are summed or dropped.`,
        [{ kind: "cable", cableId: c.cableId }],
        { cableId: c.cableId, outputChannels: outChannels, declaredInputPolyphony: "monophonic" },
        "Insert a Merge/Sum or mix the voices before this monophonic input if summing is intended.");
    }
  }

  // Third-party modules without a verified adapter are interpreted heuristically.
  const unadaptered = snap.modules.filter((m) => !hasAdapter(m.pluginSlug, m.modelSlug));
  if (unadaptered.length > 0) {
    add("adapter.unverified_modules", "info", "heuristic",
      `${unadaptered.length} module(s) have no verified adapter; their semantics are inferred and any role-based findings about them are heuristic.`,
      unadaptered.slice(0, 64).map((m): EntityRef => ({ kind: "module", moduleId: m.moduleId })),
      {
        unadapteredCount: unadaptered.length,
        models: unadaptered.slice(0, 64).map((m) => `${m.pluginSlug}/${m.modelSlug}`),
      });
  }

  // --- Silence heuristics ---
  const audioDest = snap.modules.filter(isAudioDestination);
  if (audioDest.length > 0) {
    const anyConnected = audioDest.some((m) => m.inputs.some((p) => p.connected));
    if (!anyConnected) {
      add("audio.no_input", "warning", "heuristic",
        "An audio destination exists but has no connected inputs; the patch is likely silent.",
        audioDest.map((m): EntityRef => ({ kind: "module", moduleId: m.moduleId })),
        { audioDestinationCount: audioDest.length, connectedInputCount: 0 },
        "Connect a signal source to the audio module's inputs.");
    }
  } else {
    add("audio.no_destination", "info", "heuristic",
      "No Core Audio destination module found; the patch produces no audible output.",
      [{ kind: "patch" }],
      { audioDestinationCount: 0, moduleCount: snap.modules.length });
  }

  const errorCount = findings.filter((f) => f.severity === "error").length;
  const warningCount = findings.filter((f) => f.severity === "warning").length;
  return {
    findings,
    // Which rules ran, so a caller can tell "no finding" from "not checked".
    rulesRun: [...VALIDATION_RULES],
    errorCount,
    warningCount,
    infoCount: findings.length - errorCount - warningCount,
  };
};
