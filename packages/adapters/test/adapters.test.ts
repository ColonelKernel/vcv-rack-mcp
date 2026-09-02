import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ModuleAdapter } from "@rackmcp/schemas";
import {
  ADAPTER_COUNT,
  getAdapter,
  hasAdapter,
  inputRole,
  listAdapters,
  outputRole,
  paramSemantics,
} from "../src/index.js";

/**
 * The adapter pack is only trustworthy if every documented parameter and port
 * corresponds to something that actually exists on the real module. These tests
 * cross-check the authored adapters against ground-truth `inspect_model` output
 * captured from VCV Rack 2.6.6 (Core) and Fundamental 2.6.4, and verify internal
 * consistency (unique keys, recipe references resolve, schema validity).
 */

interface GtPort {
  portId: number;
  type: "input" | "output";
  name: string;
}
interface GtParam {
  paramId: number;
  name: string;
}
interface GtModel {
  pluginSlug: string;
  modelSlug: string;
  modelName: string;
  pluginVersion: string;
  params: GtParam[];
  inputs: GtPort[];
  outputs: GtPort[];
}

const here = dirname(fileURLToPath(import.meta.url));
const GROUND_TRUTH: GtModel[] = JSON.parse(
  readFileSync(join(here, "fixtures", "model-metadata.json"), "utf8"),
);
const gtByModel = new Map<string, GtModel>(
  GROUND_TRUTH.map((m) => [`${m.pluginSlug} ${m.modelSlug}`, m]),
);

describe("adapter registry integrity", () => {
  it("registers the expected adapters with no duplicates", () => {
    const adapters = listAdapters();
    expect(adapters.length).toBe(ADAPTER_COUNT);
    const keys = new Set(adapters.map((a) => `${a.pluginSlug} ${a.modelSlug}`));
    expect(keys.size).toBe(adapters.length);
    // Core front/back ends and the Fundamental subtractive-synth chain must exist.
    for (const [plugin, model] of [
      ["Core", "AudioInterface"],
      ["Core", "AudioInterface2"],
      ["Core", "MIDIToCVInterface"],
      ["Fundamental", "VCO"],
      ["Fundamental", "VCF"],
      ["Fundamental", "VCA"],
      ["Fundamental", "VCA-1"],
      ["Fundamental", "ADSR"],
      ["Fundamental", "LFO"],
      ["RackMCP", "Bridge"],
      ["RackMCP", "Probe"],
    ] as const) {
      expect(hasAdapter(plugin, model), `${plugin} ${model} adapter`).toBe(true);
    }
  });

  it("every adapter re-validates against the ModuleAdapter schema", () => {
    for (const a of listAdapters()) {
      const r = ModuleAdapter.safeParse(a);
      expect(r.success, `${a.pluginSlug} ${a.modelSlug}: ${r.success ? "" : JSON.stringify(r.error.issues)}`).toBe(true);
    }
  });
});

describe("adapters match live inspect_model ground truth", () => {
  for (const a of listAdapters()) {
    const label = `${a.pluginSlug} ${a.modelSlug}`;
    it(`${label}: params/ports exist and match ground truth`, () => {
      const gt = gtByModel.get(label);
      expect(gt, `${label} present in ground-truth fixture`).toBeDefined();
      if (!gt) return;

      const gtParamIds = new Set(gt.params.map((p) => p.paramId));
      const gtInputIds = new Set(gt.inputs.map((p) => p.portId));
      const gtOutputIds = new Set(gt.outputs.map((p) => p.portId));

      // Port coverage must be complete: adapters describe the whole wiring surface.
      expect(a.inputs.length, `${label} input count`).toBe(gt.inputs.length);
      expect(a.outputs.length, `${label} output count`).toBe(gt.outputs.length);
      // Parameters must not exceed reality and each must correspond to a real param.
      expect(a.params.length, `${label} param count`).toBe(gt.params.length);

      for (const p of a.params) {
        expect(gtParamIds.has(p.paramId), `${label} paramId ${p.paramId}`).toBe(true);
      }
      for (const p of a.inputs) {
        expect(gtInputIds.has(p.portId), `${label} inputPortId ${p.portId}`).toBe(true);
      }
      for (const p of a.outputs) {
        expect(gtOutputIds.has(p.portId), `${label} outputPortId ${p.portId}`).toBe(true);
      }

      // No duplicate ids within a set.
      expect(new Set(a.params.map((p) => p.paramId)).size).toBe(a.params.length);
      expect(new Set(a.inputs.map((p) => p.portId)).size).toBe(a.inputs.length);
      expect(new Set(a.outputs.map((p) => p.portId)).size).toBe(a.outputs.length);
    });

    it(`${label}: semantic keys are unique and recipes resolve`, () => {
      const inputKeys = a.inputs.map((p) => p.key);
      const outputKeys = a.outputs.map((p) => p.key);
      expect(new Set(inputKeys).size, `${label} unique input keys`).toBe(inputKeys.length);
      expect(new Set(outputKeys).size, `${label} unique output keys`).toBe(outputKeys.length);

      // Param roles may legitimately repeat (e.g. per-step or per-channel roles),
      // so uniqueness is not required for them — only for addressable port keys.

      // Connection recipes must reference an output this module actually exposes.
      const outKeySet = new Set(outputKeys);
      for (const r of a.connectionRecipes) {
        expect(outKeySet.has(r.fromOutputKey), `${label} recipe fromOutputKey ${r.fromOutputKey}`).toBe(true);
      }

      // safeRange, when present, must be ordered lo <= hi.
      for (const p of a.params) {
        if (p.safeRange) expect(p.safeRange[0]).toBeLessThanOrEqual(p.safeRange[1]);
      }
    });
  }
});

describe("adapter accessors", () => {
  it("resolves roles and param semantics for known models", () => {
    // MIDI-CV pitch output is 1V/oct; gate output is a gate.
    expect(outputRole("Core", "MIDIToCVInterface", 0)).toBe("pitch_voct");
    expect(outputRole("Core", "MIDIToCVInterface", 1)).toBe("gate");
    // Audio-2 inputs are audio.
    expect(inputRole("Core", "AudioInterface2", 0)).toBe("audio");
    // VCO documents its frequency parameter.
    const vco = getAdapter("Fundamental", "VCO");
    expect(vco).toBeDefined();
    expect(vco?.params.some((p) => p.role.length > 0)).toBe(true);
    // Unknown model yields undefined, not a throw.
    expect(getAdapter("Nonexistent", "Nope")).toBeUndefined();
    expect(outputRole("Nonexistent", "Nope", 0)).toBeUndefined();
    expect(paramSemantics("Nonexistent", "Nope", 0)).toBeUndefined();
  });
});
