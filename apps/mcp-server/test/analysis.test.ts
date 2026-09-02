import { describe, expect, it } from "vitest";
import { validatePatch, describePatch } from "../src/analysis.js";
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
  return (await validatePatch({}, ctx)) as unknown as ValidateResult;
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
    expect(ruleIds(r)).toContain("port.outOfBounds");
    expect(r.errorCount).toBeGreaterThan(0);
    expect(r.valid).toBe(false);
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
    expect(ruleIds(r)).toContain("param.nonFinite");
    expect(ruleIds(r)).toContain("param.outOfRange");
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
    expect(ruleIds(r)).toContain("bypass.interruptsPath");
  });
});

describe("validatePatch adapter-backed rules", () => {
  it("surfaces an audio->control cross-patch as adapter-confidence info", async () => {
    // VCO saw (audio) into VCF cutoff CV (control).
    const vco = mod({ moduleId: "1", pluginSlug: "Fundamental", modelSlug: "VCO" });
    const vcf = mod({ moduleId: "2", pluginSlug: "Fundamental", modelSlug: "VCF" });
    const r = await runValidate([vco, vcf], [cable("10", "1", 2, "2", 0)]);
    const cross = r.findings.find((f) => f.ruleId === "adapter.signalRoleCross");
    expect(cross).toBeDefined();
    expect(cross!.confidence).toBe("adapter");
    expect(cross!.severity).toBe("info");
  });

  it("does NOT cross-flag a like-for-like audio connection", async () => {
    // VCO saw (audio) into VCF audio input (audio) — a normal connection.
    const vco = mod({ moduleId: "1", pluginSlug: "Fundamental", modelSlug: "VCO" });
    const vcf = mod({ moduleId: "2", pluginSlug: "Fundamental", modelSlug: "VCF" });
    const r = await runValidate([vco, vcf], [cable("10", "1", 2, "2", 3)]);
    expect(ruleIds(r)).not.toContain("adapter.signalRoleCross");
  });

  it("warns about a polyphonic signal entering a monophonic input", async () => {
    const vco = mod({ moduleId: "1", pluginSlug: "Fundamental", modelSlug: "VCO" });
    // Force the output cable to carry 4 channels.
    vco.outputs[2]!.channels = 4;
    const audio = mod({ moduleId: "2", pluginSlug: "Core", modelSlug: "AudioInterface2", inputs: ports(2), outputs: ports(2) });
    const r = await runValidate([vco, audio], [cable("10", "1", 2, "2", 0)]);
    expect(ruleIds(r)).toContain("adapter.polyIntoMono");
  });

  it("reports third-party modules without a verified adapter", async () => {
    const unknown = mod({ moduleId: "1", pluginSlug: "SomeVendor", modelSlug: "MysteryModule" });
    const r = await runValidate([unknown], []);
    const f = r.findings.find((x) => x.ruleId === "adapter.unverifiedModules");
    expect(f).toBeDefined();
    expect(f!.confidence).toBe("heuristic");
  });
});

describe("describePatch", () => {
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
