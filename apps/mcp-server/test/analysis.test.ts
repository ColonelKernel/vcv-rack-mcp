import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ValidatePatchOutput } from "@rackmcp/schemas";
import { validatePatch, describePatch, VALIDATION_RULES } from "../src/analysis.js";
import type { ToolContext } from "../src/tools.js";

/**
 * Drives the server-side validator with crafted patch snapshots (no live Rack),
 * exercising each rule class: structural (certain), adapter-backed, and
 * heuristic. Snapshots use real Core/Fundamental slugs so adapter role lookups
 * resolve against the verified adapter pack.
 */

interface Port {
  portId: number;
  name: string;
  connected: boolean;
  channels: number;
}
interface Mod {
  moduleId: string;
  modelName: string;
  modelSlug: string;
  pluginSlug: string;
  bypassed: boolean;
  isBridge: boolean;
  isProbe: boolean;
  params: Array<{ paramId: number; value: number; minValue: number | null; maxValue: number | null; name: string }>;
  inputs: Port[];
  outputs: Port[];
  gridPosition: { x: number; y: number } | null;
  gridWidth: number | null;
  expanders?: { left: string | null; right: string | null };
}
interface Cable {
  cableId: string;
  outputModuleId: string;
  outputId: number;
  inputModuleId: string;
  inputId: number;
}

function ports(n: number): Port[] {
  return Array.from({ length: n }, (_, i) => ({ portId: i, name: `p${i}`, connected: false, channels: 1 }));
}
function mod(over: Partial<Mod> & { moduleId: string; pluginSlug: string; modelSlug: string }): Mod {
  return {
    modelName: over.modelSlug,
    bypassed: false,
    isBridge: false,
    isProbe: false,
    params: [],
    inputs: ports(8),
    outputs: ports(8),
    gridPosition: null,
    gridWidth: null,
    ...over,
  };
}

interface Finding { ruleId: string; severity: string; confidence: string }
interface ValidateResult { findings: Finding[]; errorCount: number; warningCount: number; valid: boolean }

async function runValidate(modules: Mod[], cables: Cable[], bridgeModuleCount = 1): Promise<ValidateResult> {
  // Reflect cable connectivity onto the ports the validator reads.
  for (const c of cables) {
    const o = modules.find((m) => m.moduleId === c.outputModuleId);
    const i = modules.find((m) => m.moduleId === c.inputModuleId);
    if (o?.outputs[c.outputId]) o.outputs[c.outputId]!.connected = true;
    if (i?.inputs[c.inputId]) i.inputs[c.inputId]!.connected = true;
  }
  const snap = { modules, cables, bridgeModuleCount, patchEpoch: 1 };
  const ctx = { conn: { request: async () => snap } } as unknown as ToolContext;
  const report = await validatePatch({}, ctx);
  // Every case below goes through here, so strict-parsing the report once makes
  // all of them contract tests as well: each exercises a different rule, and a
  // finding that does not match the published ValidationFinding shape (entity
  // refs keyed on `kind`, a required `evidence` record, `suggestedRepair`
  // omitted rather than null, a snake_case ruleId) fails the test that produced
  // it. The server only logs this mismatch at runtime, so nothing else catches it.
  const parsed = ValidatePatchOutput.safeParse(report);
  if (!parsed.success) {
    throw new Error(
      "validate_patch output violates ValidatePatchOutput: " +
        parsed.error.issues
          .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
          .join("; "),
    );
  }
  return report as unknown as ValidateResult;
}

function ruleIds(r: ValidateResult): string[] {
  return r.findings.map((f) => f.ruleId);
}

const cable = (cableId: string, outMod: string, outId: number, inMod: string, inId: number): Cable => ({
  cableId, outputModuleId: outMod, outputId: outId, inputModuleId: inMod, inputId: inId,
});

describe("validatePatch structural rules", () => {
  it("flags a dangling cable and an out-of-bounds port", async () => {
    const vco = mod({ moduleId: "1", pluginSlug: "Fundamental", modelSlug: "VCO" });
    const r = await runValidate(
      [vco],
      [cable("10", "1", 2, "999", 0), cable("11", "1", 99, "1", 0)],
    );
    expect(ruleIds(r)).toContain("cable.dangling");
    expect(ruleIds(r)).toContain("port.out_of_bounds");
    expect(r.errorCount).toBeGreaterThan(0);
  });

  it("flags duplicate cables and stacked inputs", async () => {
    const vco = mod({ moduleId: "1", pluginSlug: "Fundamental", modelSlug: "VCO" });
    const vcf = mod({ moduleId: "2", pluginSlug: "Fundamental", modelSlug: "VCF" });
    const r = await runValidate(
      [vco, vcf],
      [cable("10", "1", 2, "2", 3), cable("11", "1", 2, "2", 3)],
    );
    expect(ruleIds(r)).toContain("cable.duplicate");
    expect(ruleIds(r)).toContain("inputs.stacked");
  });

  it("flags position collisions and non-finite / out-of-range params", async () => {
    const a = mod({ moduleId: "1", pluginSlug: "Fundamental", modelSlug: "VCO", gridPosition: { x: 0, y: 0 }, gridWidth: 10,
      params: [{ paramId: 0, value: Number.NaN, minValue: 0, maxValue: 1, name: "bad" }] });
    const b = mod({ moduleId: "2", pluginSlug: "Fundamental", modelSlug: "VCF", gridPosition: { x: 0, y: 0 }, gridWidth: 10,
      params: [{ paramId: 0, value: 5, minValue: 0, maxValue: 1, name: "hi" }] });
    const r = await runValidate([a, b], []);
    expect(ruleIds(r)).toContain("module.collision");
    expect(ruleIds(r)).toContain("param.non_finite");
    expect(ruleIds(r)).toContain("param.out_of_range");
  });

  it("warns when the patch has no Bridge module", async () => {
    const audio = mod({ moduleId: "1", pluginSlug: "Core", modelSlug: "AudioInterface2", inputs: ports(2), outputs: ports(2) });
    const r = await runValidate([audio], [], 0);
    expect(ruleIds(r)).toContain("bridge.missing");
  });

  it("flags an expander that is not physically adjacent", async () => {
    const host = mod({ moduleId: "1", pluginSlug: "Fundamental", modelSlug: "VCO", gridPosition: { x: 0, y: 0 }, gridWidth: 10 });
    const exp = mod({ moduleId: "2", pluginSlug: "Fundamental", modelSlug: "VCF", gridPosition: { x: 50, y: 0 }, gridWidth: 8,
      expanders: { left: "1", right: null } });
    const r = await runValidate([host, exp], []);
    expect(ruleIds(r)).toContain("expander.adjacency");
  });

  it("does not flag a correctly-adjacent expander", async () => {
    const host = mod({ moduleId: "1", pluginSlug: "Fundamental", modelSlug: "VCO", gridPosition: { x: 0, y: 0 }, gridWidth: 10 });
    const exp = mod({ moduleId: "2", pluginSlug: "Fundamental", modelSlug: "VCF", gridPosition: { x: 10, y: 0 }, gridWidth: 8,
      expanders: { left: "1", right: null } });
    const r = await runValidate([host, exp], []);
    expect(ruleIds(r)).not.toContain("expander.adjacency");
  });
});

describe("validatePatch feedback + bypass", () => {
  it("reports a feedback cycle as info, never as an error", async () => {
    // VCF (2) -> VCA (3) -> back into VCF: a 2-module loop.
    const vcf = mod({ moduleId: "2", pluginSlug: "Fundamental", modelSlug: "VCF" });
    const vca = mod({ moduleId: "3", pluginSlug: "Fundamental", modelSlug: "VCA-1", inputs: ports(2), outputs: ports(1) });
    const r = await runValidate(
      [vcf, vca],
      [cable("10", "2", 0, "3", 1), cable("11", "3", 0, "2", 3)],
    );
    const cyc = r.findings.find((f) => f.ruleId === "cycle.feedback");
    expect(cyc).toBeDefined();
    expect(cyc!.severity).toBe("info");
    // A cycle alone is not an error.
    expect(r.findings.filter((f) => f.ruleId === "cycle.feedback" && f.severity === "error")).toHaveLength(0);
  });

  it("warns about a bypassed module interrupting a path to the audio output", async () => {
    const vco = mod({ moduleId: "1", pluginSlug: "Fundamental", modelSlug: "VCO" });
    const vcf = mod({ moduleId: "2", pluginSlug: "Fundamental", modelSlug: "VCF", bypassed: true });
    const audio = mod({ moduleId: "3", pluginSlug: "Core", modelSlug: "AudioInterface2", inputs: ports(2), outputs: ports(2) });
    const r = await runValidate(
      [vco, vcf, audio],
      [cable("10", "1", 2, "2", 3), cable("11", "2", 0, "3", 0)],
    );
    expect(ruleIds(r)).toContain("bypass.interrupts_path");
  });
});

describe("validatePatch adapter-backed rules", () => {
  it("surfaces an audio->control cross-patch as adapter-confidence info", async () => {
    // VCO saw (audio) into VCF cutoff CV (control).
    const vco = mod({ moduleId: "1", pluginSlug: "Fundamental", modelSlug: "VCO" });
    const vcf = mod({ moduleId: "2", pluginSlug: "Fundamental", modelSlug: "VCF" });
    const r = await runValidate([vco, vcf], [cable("10", "1", 2, "2", 0)]);
    const cross = r.findings.find((f) => f.ruleId === "adapter.signal_role_cross");
    expect(cross).toBeDefined();
    expect(cross!.confidence).toBe("adapter");
    expect(cross!.severity).toBe("info");
  });

  it("does NOT cross-flag a like-for-like audio connection", async () => {
    // VCO saw (audio) into VCF audio input (audio) — a normal connection.
    const vco = mod({ moduleId: "1", pluginSlug: "Fundamental", modelSlug: "VCO" });
    const vcf = mod({ moduleId: "2", pluginSlug: "Fundamental", modelSlug: "VCF" });
    const r = await runValidate([vco, vcf], [cable("10", "1", 2, "2", 3)]);
    expect(ruleIds(r)).not.toContain("adapter.signal_role_cross");
  });

  it("warns about a polyphonic signal entering a monophonic input", async () => {
    const vco = mod({ moduleId: "1", pluginSlug: "Fundamental", modelSlug: "VCO" });
    // Force the output cable to carry 4 channels.
    vco.outputs[2]!.channels = 4;
    const audio = mod({ moduleId: "2", pluginSlug: "Core", modelSlug: "AudioInterface2", inputs: ports(2), outputs: ports(2) });
    const r = await runValidate([vco, audio], [cable("10", "1", 2, "2", 0)]);
    expect(ruleIds(r)).toContain("adapter.poly_into_mono");
  });

  it("reports third-party modules without a verified adapter", async () => {
    const unknown = mod({ moduleId: "1", pluginSlug: "SomeVendor", modelSlug: "MysteryModule" });
    const r = await runValidate([unknown], []);
    const f = r.findings.find((x) => x.ruleId === "adapter.unverified_modules");
    expect(f).toBeDefined();
    expect(f!.confidence).toBe("heuristic");
  });
});

describe("validatePatch adapter advisories", () => {
  it("flags a gate output driving a 1V/oct input as pitch/gate confusion", async () => {
    // MIDI-to-CV gate output (port 1) into the VCO's pitch input (port 0).
    const midi = mod({ moduleId: "1", pluginSlug: "Core", modelSlug: "MIDIToCVInterface", inputs: ports(0), outputs: ports(12) });
    const vco = mod({ moduleId: "2", pluginSlug: "Fundamental", modelSlug: "VCO", inputs: ports(4), outputs: ports(4) });
    const r = await runValidate([midi, vco], [cable("10", "1", 1, "2", 0)]);
    const f = r.findings.find((x) => x.ruleId === "adapter.pitch_gate_confusion");
    expect(f).toBeDefined();
    // Advisory only: the spec forbids calling a role mismatch an incompatibility.
    expect(f!.severity).toBe("info");
    expect(f!.confidence).toBe("adapter");
    // Advisory findings must not make the patch invalid.
    expect(r.errorCount).toBe(0);
  });

  it("does not flag the correct pitch and gate wiring", async () => {
    const midi = mod({ moduleId: "1", pluginSlug: "Core", modelSlug: "MIDIToCVInterface", inputs: ports(0), outputs: ports(12) });
    const vco = mod({ moduleId: "2", pluginSlug: "Fundamental", modelSlug: "VCO", inputs: ports(4), outputs: ports(4) });
    const adsr = mod({ moduleId: "3", pluginSlug: "Fundamental", modelSlug: "ADSR", inputs: ports(6), outputs: ports(1) });
    const r = await runValidate(
      [midi, vco, adsr],
      [cable("10", "1", 0, "2", 0), cable("11", "1", 1, "3", 4)], // pitch→pitch, gate→gate
    );
    expect(ruleIds(r)).not.toContain("adapter.pitch_gate_confusion");
  });

  it("flags a parameter outside the adapter's safe range but inside its hard bounds", async () => {
    // VCF resonance: hard bounds [0,1], adapter safeRange [0,0.9].
    const vcf = mod({
      moduleId: "1", pluginSlug: "Fundamental", modelSlug: "VCF",
      params: [{ paramId: 2, value: 0.98, minValue: 0, maxValue: 1, name: "Resonance" }],
    });
    const r = await runValidate([vcf], []);
    const f = r.findings.find((x) => x.ruleId === "param.outside_safe_range");
    expect(f).toBeDefined();
    expect(f!.confidence).toBe("adapter");
    expect(f!.severity).toBe("info");
    // The stronger hard-bounds rule must not also fire for a legal value.
    expect(ruleIds(r)).not.toContain("param.out_of_range");
  });

  it("stays quiet for a parameter inside the safe range", async () => {
    const vcf = mod({
      moduleId: "1", pluginSlug: "Fundamental", modelSlug: "VCF",
      params: [{ paramId: 2, value: 0.5, minValue: 0, maxValue: 1, name: "Resonance" }],
    });
    expect(ruleIds(await runValidate([vcf], []))).not.toContain("param.outside_safe_range");
  });
});

describe("describePatch", () => {
  /** Runs describe_patch against a crafted snapshot. */
  async function runDescribe(modules: Mod[], cables: Cable[]) {
    const snap = { modules, cables, bridgeModuleCount: 1, patchEpoch: 1 };
    const ctx = { conn: { request: async () => snap } } as unknown as ToolContext;
    return (await describePatch({}, ctx)) as unknown as {
      chains: Array<{ description: string; moduleIds: string[]; confidence: string }>;
      unknownModuleCount: number;
      summary: string;
    };
  }

  it("describes only real cables in a branching patch", async () => {
    // The shipped basic_mono_subtractive topology: MIDI feeds both the VCO and
    // the envelope, so a flat traversal order would put VCF next to MIDI-to-CV.
    const midi = mod({ moduleId: "1", modelName: "MIDI to CV", pluginSlug: "Core", modelSlug: "MIDIToCVInterface", inputs: ports(0), outputs: ports(12) });
    const vco = mod({ moduleId: "2", modelName: "VCO", pluginSlug: "Fundamental", modelSlug: "VCO", inputs: ports(4), outputs: ports(4) });
    const vcf = mod({ moduleId: "3", modelName: "VCF", pluginSlug: "Fundamental", modelSlug: "VCF", inputs: ports(4), outputs: ports(2) });
    const env = mod({ moduleId: "4", modelName: "ADSR EG", pluginSlug: "Fundamental", modelSlug: "ADSR", inputs: ports(6), outputs: ports(1) });
    const vca = mod({ moduleId: "5", modelName: "VCA", pluginSlug: "Fundamental", modelSlug: "VCA", inputs: ports(4), outputs: ports(2) });
    const audio = mod({ moduleId: "6", modelName: "Audio 2", pluginSlug: "Core", modelSlug: "AudioInterface2", inputs: ports(2), outputs: ports(2) });
    const cables = [
      cable("10", "1", 0, "2", 0), // MIDI pitch -> VCO
      cable("11", "1", 1, "4", 4), // MIDI gate  -> ADSR
      cable("12", "2", 2, "3", 3), // VCO -> VCF
      cable("13", "4", 0, "5", 0), // ADSR -> VCA CV
      cable("14", "3", 0, "5", 1), // VCF -> VCA
      cable("15", "5", 0, "6", 0), // VCA -> Audio
      cable("16", "5", 0, "6", 1),
    ];
    const r = await runDescribe([midi, vco, vcf, env, vca, audio], cables);
    expect(r.chains).toHaveLength(1);
    const { description, moduleIds } = r.chains[0]!;

    // Every arrow in the description must correspond to a real cable.
    const nameToId = new Map([["MIDI to CV", "1"], ["VCO", "2"], ["VCF", "3"], ["ADSR EG", "4"], ["VCA", "5"], ["Audio 2", "6"]]);
    const realPairs = new Set(cables.map((c) => `${c.outputModuleId}->${c.inputModuleId}`));
    const segments = description.replace(/^[^:]*:\s*/, "").split("; also feeding it: ");
    for (const segment of segments) {
      for (const clause of segment.split(", ")) {
        const names = clause.split(" → ");
        for (let i = 1; i < names.length; i++) {
          const from = nameToId.get(names[i - 1]!.trim());
          const to = nameToId.get(names[i]!.trim());
          expect(from, `unknown module name in "${clause}"`).toBeDefined();
          expect(realPairs.has(`${from}->${to}`), `"${names[i - 1]} → ${names[i]}" is not a real cable`).toBe(true);
        }
      }
    }
    // The specific edge the old traversal fabricated.
    expect(description).not.toContain("VCF → MIDI to CV");
    // Both branches are still reported.
    expect(description).toContain("ADSR EG");
    expect(moduleIds).toContain("4");
    expect(new Set(moduleIds).size).toBe(moduleIds.length);
  });

  it("handles a feedback loop without inventing an edge or hanging", async () => {
    const a = mod({ moduleId: "1", modelName: "A", pluginSlug: "Fundamental", modelSlug: "VCO" });
    const b = mod({ moduleId: "2", modelName: "B", pluginSlug: "Fundamental", modelSlug: "VCF" });
    const audio = mod({ moduleId: "3", modelName: "Audio 2", pluginSlug: "Core", modelSlug: "AudioInterface2", inputs: ports(2), outputs: ports(2) });
    const r = await runDescribe(
      [a, b, audio],
      [cable("10", "1", 0, "2", 3), cable("11", "2", 0, "1", 1), cable("12", "2", 0, "3", 0)],
    );
    const { description, moduleIds } = r.chains[0]!;
    expect(description).toContain("Audio 2");
    expect(new Set(moduleIds).size).toBe(moduleIds.length);
  });

  it("summarizes chains and counts unadaptered modules", async () => {
    const vco = mod({ moduleId: "1", pluginSlug: "Fundamental", modelSlug: "VCO" });
    const audio = mod({ moduleId: "2", pluginSlug: "Core", modelSlug: "AudioInterface2", inputs: ports(2), outputs: ports(2) });
    const other = mod({ moduleId: "3", pluginSlug: "SomeVendor", modelSlug: "Mystery" });
    const snap = { modules: [vco, audio, other], cables: [cable("10", "1", 2, "2", 0)], bridgeModuleCount: 1, patchEpoch: 1 };
    const ctx = { conn: { request: async () => snap } } as unknown as ToolContext;
    const r = (await describePatch({}, ctx)) as unknown as { chains: unknown[]; unknownModuleCount: number; summary: string };
    expect(r.chains.length).toBeGreaterThan(0);
    expect(r.unknownModuleCount).toBe(1);
    expect(r.summary).toContain("modules");
  });
});

describe("validation rule inventory", () => {
  /**
   * `rulesRun` is what lets a caller tell "checked, nothing found" from "never
   * checked", so it has to name every rule the validator can emit. Reading the
   * source keeps the constant honest: a rule added with a fresh id but no entry
   * in VALIDATION_RULES fails here rather than shipping a report that quietly
   * under-claims what was checked.
   */
  it("VALIDATION_RULES names exactly the rules validatePatch can emit", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../src/analysis.ts", import.meta.url)),
      "utf8",
    );
    const emitted = new Set<string>();
    for (const m of src.matchAll(/\badd\(\s*"([a-zA-Z][\w.]*)"/g)) emitted.add(m[1]!);
    expect(emitted.size).toBeGreaterThan(0);
    const declared = new Set<string>(VALIDATION_RULES);
    expect([...emitted].filter((r) => !declared.has(r))).toEqual([]);
    expect([...declared].filter((r) => !emitted.has(r))).toEqual([]);
  });

  it("reports every rule as run", async () => {
    const r = await runValidate([mod({ moduleId: "1", pluginSlug: "Fundamental", modelSlug: "VCO" })], []);
    expect(r.rulesRun).toEqual([...VALIDATION_RULES]);
  });
});
