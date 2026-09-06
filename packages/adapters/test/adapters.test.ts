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
  minValue: number;
  maxValue: number;
  defaultValue: number;
  /**
   * What Rack shows for the parameter's current (== default, in a freshly
   * instantiated module) value. For a snapped switch this is the NAME of the
   * default position -- "Unipolar", "Linear", "Disabled" -- which is the single
   * most load-bearing fact about a two-position switch and the one an adapter
   * is most likely to get backwards.
   */
  displayValue?: string;
  snapped?: boolean;
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

/**
 * Every position of every snapped two-position switch on the documented
 * Core/Fundamental models, measured in a live Rack 2.6.6 by
 * `tests/integration/src/capture-switch-positions.ts`.
 *
 * `model-metadata.json` inspects a freshly instantiated module, so it only ever
 * records the DEFAULT position's display name. Three adapters were written from
 * that gap and stated the opposite default -- the LFO's outputs were documented
 * as bipolar "by default" against a ground-truth `Unipolar`, VCA-1's response
 * curve as "exponential (default)" against `Linear`, the Scope's trigger as "on
 * by default" against `Disabled` -- and every id-and-count test passed the whole
 * time while the prose told a user the reverse of what the module does.
 */
interface SwitchPosition {
  value: number;
  displayValue: string | null;
}
interface SwitchRecord {
  pluginSlug: string;
  modelSlug: string;
  paramId: number;
  name: string;
  defaultValue: number;
  positions: SwitchPosition[];
}
const SWITCHES: SwitchRecord[] = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../tests/fixtures/adapters/switch-positions.json", import.meta.url)),
    "utf8",
  ),
);

describe("adapter switch descriptions match every measured position", () => {
  /**
   * A description cannot be checked as prose, but the position table can be.
   * Each switch must spell out what Rack renders for each position it names,
   * and which value is the default -- naming a position alone is not enough,
   * since the defect this catches is naming it as the value it is NOT.
   */
  const named = (pos: SwitchPosition) => (pos.displayValue ?? "").trim();
  // Only switches Rack renders a NAME for. A momentary push button or a mute
  // toggle displays nothing at either position, so there is no name to get
  // backwards and nothing here to check. The capture records them anyway --
  // proving a switch is unnamed takes the same measurement as reading its name.
  const CHECKED = SWITCHES.filter(
    (sw) => getAdapter(sw.pluginSlug, sw.modelSlug) && sw.positions.some(named),
  );

  it("has something to check", () => {
    // Guard against the filters above quietly reducing this suite to nothing.
    expect(CHECKED.length).toBeGreaterThanOrEqual(4);
  });

  for (const sw of CHECKED) {
    const label = `${sw.pluginSlug} ${sw.modelSlug} p${sw.paramId} (${sw.name})`;
    it(`${label}: documents both positions and the default`, () => {
      const ap = getAdapter(sw.pluginSlug, sw.modelSlug)!.params.find(
        (p) => p.paramId === sw.paramId,
      );
      expect(ap, `${label}: parameter documented`).toBeDefined();
      const description = ap!.description ?? "";

      for (const pos of sw.positions) {
        const display = named(pos);
        if (!display) continue; // Rack renders no name for this position
        expect(description, `${label}: must contain '${pos.value} = "${display}"'`).toContain(
          `${pos.value} = "${display}"`,
        );
      }
      expect(description, `${label}: must contain 'default is ${sw.defaultValue}'`).toContain(
        `default is ${sw.defaultValue}`,
      );
    });
  }

  it("covers every snapped two-position parameter in the ground-truth fixture", () => {
    // Deriving "does this need capturing?" from model-metadata's displayValue
    // would repeat the very blindness this fixture exists to cure: that field
    // records the DEFAULT position only, so a switch whose default renders no
    // name but whose other position renders "Latched" would look unnamed and
    // escape both the capture requirement and the description gate. Every
    // snapped two-position parameter must be captured, named or not -- proving
    // a switch is unnamed takes the same measurement as reading its name.
    const captured = new Set(SWITCHES.map((s) => `${s.pluginSlug} ${s.modelSlug} ${s.paramId}`));
    const missing: string[] = [];
    for (const a of listAdapters()) {
      // RackMCP's own modules are deliberately never swept: Bridge paramId 0 is
      // "Reset pairing secret", and the capture speaks to Rack over that very
      // bridge. See tests/integration/src/capture-switch-positions.ts.
      if (a.pluginSlug === "RackMCP") continue;
      const gt = gtByModel.get(`${a.pluginSlug} ${a.modelSlug}`);
      if (!gt) continue;
      for (const p of gt.params) {
        if (!p.snapped || p.maxValue - p.minValue !== 1) continue;
        const key = `${a.pluginSlug} ${a.modelSlug} ${p.paramId}`;
        if (!captured.has(key)) missing.push(key);
      }
    }
    expect(missing, "snapped two-position switches with no captured positions").toEqual([]);
  });
});

describe("adapters state a default only where it is checked", () => {
  /**
   * The switch gate above reads `params[].description`, because that is where
   * the canonical clause lives. But the original LFO defect was NOT in a param
   * description -- it was in the four `outputs[].description` texts ("Bipolar
   * modulation signal by default (approx. +/-5 V)") and in the module `summary`.
   * A gate that only reads params would let exactly that text come back.
   *
   * Prose cannot be checked as prose, but WHERE a default may be asserted can
   * be. On a model with a measured named switch, an assertive "by default" or
   * "(default)" anywhere outside the checked clause is a claim no test can
   * verify -- and all three shipped defects were spelled that way. Port and
   * summary text should describe what the port does and point at the switch;
   * the default itself belongs in the params table, where the measured fixture
   * has the last word.
   */
  const ASSERTIVE_DEFAULT = /by default|\(default\)/i;
  const withNamedSwitch = new Set(
    SWITCHES.filter((sw) => sw.positions.some((p) => (p.displayValue ?? "").trim())).map(
      (sw) => `${sw.pluginSlug} ${sw.modelSlug}`,
    ),
  );

  for (const a of listAdapters()) {
    const label = `${a.pluginSlug} ${a.modelSlug}`;
    if (!withNamedSwitch.has(label)) continue;
    it(`${label}: no bare default claim outside the checked clause`, () => {
      const texts: Array<[string, string]> = [
        ["summary", a.summary],
        ...a.params.map((p) => [`param ${p.paramId}`, p.description ?? ""] as [string, string]),
        ...a.inputs.map((p) => [`input ${p.portId}`, p.description ?? ""] as [string, string]),
        ...a.outputs.map((p) => [`output ${p.portId}`, p.description ?? ""] as [string, string]),
        ...a.connectionRecipes.map(
          (r) => [`recipe "${r.name}"`, r.description ?? ""] as [string, string],
        ),
      ];
      for (const [where, text] of texts) {
        const hit = ASSERTIVE_DEFAULT.exec(text);
        expect(
          hit,
          `${label} ${where}: says ${JSON.stringify(hit?.[0])} in "${text.slice(Math.max(0, (hit?.index ?? 0) - 60), (hit?.index ?? 0) + 60)}". ` +
            `State the default in the parameter's 'default is N, ... = "Name"' clause, where the ` +
            `measured switch fixture checks it; elsewhere, name the controlling parameter instead.`,
        ).toBeNull();
      }
    });
  }
});

describe("adapter numeric bounds match captured ground truth", () => {
  /**
   * `safeRange` is not decoration: analysis.ts reports any live parameter
   * outside it as a validation finding. A safeRange that escapes the real
   * [minValue, maxValue] describes values the parameter cannot hold, and a
   * safeInitial outside its own safeRange would have the adapter recommend a
   * starting value that its own validation then flags.
   */
  for (const a of listAdapters()) {
    const label = `${a.pluginSlug} ${a.modelSlug}`;
    const gt = gtByModel.get(label);
    if (!gt) continue;
    const gtParams = new Map(gt.params.map((p) => [p.paramId, p]));

    it(`${label}: safeInitial and safeRange lie inside the real parameter range`, () => {
      for (const ap of a.params) {
        const p = gtParams.get(ap.paramId);
        expect(p, `${label} p${ap.paramId} in ground truth`).toBeDefined();
        const range = `[${p!.minValue}, ${p!.maxValue}]`;
        if (ap.safeRange) {
          const [lo, hi] = ap.safeRange;
          expect(lo, `${label} p${ap.paramId} safeRange lo vs hard range ${range}`).toBeGreaterThanOrEqual(p!.minValue);
          expect(hi, `${label} p${ap.paramId} safeRange hi vs hard range ${range}`).toBeLessThanOrEqual(p!.maxValue);
        }
        if (typeof ap.safeInitial === "number") {
          expect(ap.safeInitial, `${label} p${ap.paramId} safeInitial vs hard range ${range}`).toBeGreaterThanOrEqual(p!.minValue);
          expect(ap.safeInitial, `${label} p${ap.paramId} safeInitial vs hard range ${range}`).toBeLessThanOrEqual(p!.maxValue);
          if (ap.safeRange) {
            expect(ap.safeInitial, `${label} p${ap.paramId} safeInitial inside its own safeRange`).toBeGreaterThanOrEqual(ap.safeRange[0]);
            expect(ap.safeInitial, `${label} p${ap.paramId} safeInitial inside its own safeRange`).toBeLessThanOrEqual(ap.safeRange[1]);
          }
        }
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
