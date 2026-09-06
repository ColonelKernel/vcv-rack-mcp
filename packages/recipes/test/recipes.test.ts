import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Recipe } from "@rackmcp/schemas";
import { getAdapter, listAdapters } from "@rackmcp/adapters";
import {
  RECIPE_COUNT,
  expandRecipeOperations,
  getRecipe,
  listRecipes,
  resolveRecipe,
  type InstalledModel,
} from "../src/index.js";

/**
 * Recipes must wire only real ports and parameters, and must resolve/expand
 * without ever silently substituting an unknown module. These tests cross-check
 * every operation against the verified adapter pack and exercise the resolver.
 */

const EXPECTED_IDS = [
  "basic_mono_subtractive",
  "poly_midi_subtractive",
  "clocked_8_step_sequence",
  "stereo_delay_send_return",
  "safe_master_output",
  "lfo_filter_modulation",
  "sidechain_envelope_follow",
  "probe_silence_diagnosis",
];

/** Map each transaction alias to the concrete model its add_module resolves to. */
function aliasModels(recipe: ReturnType<typeof getRecipe>): Map<string, InstalledModel> {
  const rolePreferred = new Map(recipe!.roles.map((r) => [r.role, r.preferred]));
  const out = new Map<string, InstalledModel>();
  for (const op of recipe!.operations) {
    if (op.op !== "add_module") continue;
    if (op.pluginSlug === "$role") {
      const pref = rolePreferred.get(op.modelSlug);
      expect(pref, `role ${op.modelSlug} declared for alias ${op.alias}`).toBeDefined();
      out.set(op.alias, { pluginSlug: pref!.pluginSlug, modelSlug: pref!.modelSlug });
    } else {
      out.set(op.alias, { pluginSlug: op.pluginSlug, modelSlug: op.modelSlug });
    }
  }
  return out;
}

describe("recipe registry", () => {
  it("registers exactly the eight required recipes with unique ids", () => {
    expect(RECIPE_COUNT).toBe(EXPECTED_IDS.length);
    const ids = listRecipes().map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...EXPECTED_IDS].sort());
  });

  it("every recipe re-validates against the Recipe schema", () => {
    for (const r of listRecipes()) {
      const res = Recipe.safeParse(r);
      expect(res.success, `${r.id}: ${res.success ? "" : JSON.stringify(res.error.issues)}`).toBe(true);
    }
  });
});

describe("recipe operations wire only verified ports/params", () => {
  for (const id of EXPECTED_IDS) {
    it(`${id}: aliases, ports and params are consistent with the adapter pack`, () => {
      const recipe = getRecipe(id);
      expect(recipe).toBeDefined();
      const models = aliasModels(recipe);

      // Every role's preferred model must have a verified adapter (so its ports
      // are ground-truth). This is what lets us trust the wiring below.
      for (const role of recipe!.roles) {
        const a = getAdapter(role.preferred.pluginSlug, role.preferred.modelSlug);
        expect(a, `${id} role ${role.role} preferred ${role.preferred.pluginSlug}/${role.preferred.modelSlug} has adapter`).toBeDefined();
      }

      // add_module aliases are unique.
      const addAliases = recipe!.operations.filter((o) => o.op === "add_module").map((o) => (o as { alias: string }).alias);
      expect(new Set(addAliases).size, `${id} unique aliases`).toBe(addAliases.length);

      for (const op of recipe!.operations) {
        if (op.op === "connect") {
          for (const [end, ref] of [["output", op.output], ["input", op.input]] as const) {
            const alias = "alias" in ref.module ? ref.module.alias : undefined;
            expect(alias, `${id} connect ${end} uses an alias`).toBeDefined();
            const m = models.get(alias!);
            expect(m, `${id} connect ${end} alias ${alias} was added`).toBeDefined();
            const a = getAdapter(m!.pluginSlug, m!.modelSlug)!;
            const ports = ref.portType === "output" ? a.outputs : a.inputs;
            expect(
              ports.some((p) => p.portId === ref.portId),
              `${id}: ${m!.pluginSlug}/${m!.modelSlug} ${ref.portType} port ${ref.portId} exists`,
            ).toBe(true);
          }
        } else if (op.op === "set_parameter") {
          const alias = "alias" in op.module ? op.module.alias : undefined;
          expect(alias, `${id} set_parameter uses an alias`).toBeDefined();
          const m = models.get(alias!);
          expect(m, `${id} set_parameter alias ${alias} was added`).toBeDefined();
          const a = getAdapter(m!.pluginSlug, m!.modelSlug)!;
          expect(
            a.params.some((p) => p.paramId === op.paramId),
            `${id}: ${m!.pluginSlug}/${m!.modelSlug} param ${op.paramId} exists`,
          ).toBe(true);
          // normalized targets stay in range.
          if (typeof op.normalized === "number") {
            expect(op.normalized).toBeGreaterThanOrEqual(0);
            expect(op.normalized).toBeLessThanOrEqual(1);
          }
        }
      }
    });
  }
});

/**
 * Ground-truth parameter ranges captured by `inspect_model` from VCV Rack 2.6.6
 * (Core) and Fundamental 2.6.4 -- the same fixture the adapter pack is checked
 * against. Recipes set parameters by NORMALIZED value, so the raw value a
 * recipe actually produces is invisible in the source and can only be judged
 * against the real [minValue, maxValue] of the parameter.
 */
interface GtParam {
  paramId: number;
  name: string;
  minValue: number;
  maxValue: number;
  defaultValue: number;
}
interface GtModel {
  pluginSlug: string;
  modelSlug: string;
  params: GtParam[];
}
const GROUND_TRUTH: GtModel[] = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../adapters/test/fixtures/model-metadata.json", import.meta.url)),
    "utf8",
  ),
);
const gtByModel = new Map<string, GtModel>(
  GROUND_TRUTH.map((m) => [`${m.pluginSlug} ${m.modelSlug}`, m]),
);

/** Rack maps a normalized [0..1] value linearly onto [minValue, maxValue]. */
function rawFromNormalized(gt: GtParam, normalized: number): number {
  return gt.minValue + normalized * (gt.maxValue - gt.minValue);
}

describe("recipe parameter targets land inside the adapter's own safe range", () => {
  /**
   * A recipe is the one place in this system that both authors a patch and is
   * then judged by validate_patch, which reports any live parameter outside its
   * adapter's `safeRange` (see analysis.ts). A recipe whose own normalized
   * target decodes to a raw value outside that range therefore builds a patch
   * that the very next validate_patch flags -- the tool contradicting itself in
   * front of the user.
   *
   * Normalized-to-raw is the step that hides this: `0.2` looks unremarkable
   * next to a `safeRange` of [-4, 6] until you know the parameter's real range
   * is [-8, 10] and 0.2 means -4.4.
   */
  for (const id of EXPECTED_IDS) {
    it(`${id}: every normalized target decodes inside safeRange`, () => {
      const recipe = getRecipe(id);
      const models = aliasModels(recipe);
      const unjudged: string[] = [];
      for (const op of recipe!.operations) {
        if (op.op !== "set_parameter" || typeof op.normalized !== "number") continue;
        const alias = "alias" in op.module ? op.module.alias : undefined;
        const m = models.get(alias!)!;
        const label = `${id} ${alias} (${m.pluginSlug}/${m.modelSlug}) param ${op.paramId}`;

        const gtModel = gtByModel.get(`${m.pluginSlug} ${m.modelSlug}`);
        expect(gtModel, `${label}: model present in ground truth`).toBeDefined();
        const gtParam = gtModel!.params.find((p) => p.paramId === op.paramId);
        expect(gtParam, `${label}: param present in ground truth`).toBeDefined();

        const raw = rawFromNormalized(gtParam!, op.normalized);
        // Sanity: a normalized value can never leave the hard range.
        expect(raw, `${label} raw >= min`).toBeGreaterThanOrEqual(gtParam!.minValue);
        expect(raw, `${label} raw <= max`).toBeLessThanOrEqual(gtParam!.maxValue);

        const safe = getAdapter(m.pluginSlug, m.modelSlug)!.params.find(
          (p) => p.paramId === op.paramId,
        )?.safeRange;
        if (!safe) {
          // No declared safe range, so there is nothing here to contradict --
          // but say so rather than let the pass rate imply full coverage. The
          // zero-depth defect above lived in exactly one of these skipped ops.
          unjudged.push(`${label} "${gtParam!.name}"`);
          continue;
        }
        expect(
          raw,
          `${label}: normalized ${op.normalized} decodes to raw ${raw} (${gtParam!.name}, hard range [${gtParam!.minValue}, ${gtParam!.maxValue}]), below the adapter safeRange [${safe[0]}, ${safe[1]}]`,
        ).toBeGreaterThanOrEqual(safe[0]);
        expect(
          raw,
          `${label}: normalized ${op.normalized} decodes to raw ${raw} (${gtParam!.name}, hard range [${gtParam!.minValue}, ${gtParam!.maxValue}]), above the adapter safeRange [${safe[0]}, ${safe[1]}]`,
        ).toBeLessThanOrEqual(safe[1]);
      }
      if (unjudged.length > 0) {
        console.info(`  ${id}: ${unjudged.length} target(s) had no safeRange to judge: ${unjudged.join(", ")}`);
      }
    });
  }
});

describe("recipe modulation depths are not silently zero", () => {
  /**
   * `lfo_filter_modulation` cabled its LFO into the VCF's cutoff CV input and
   * then set the attenuverter that scales that input to normalized 0.5 --
   * which, on a BIPOLAR [-1, 1] attenuverter, is raw 0.0, the adapter's own
   * documented "no external cutoff modulation" position. The recipe whose
   * entire purpose is sweeping the cutoff built a patch with a static filter,
   * while its description and notes both promised a sweep.
   *
   * Nothing caught it. The parameter existed, the normalized value was in
   * [0,1], and the safeRange gate skipped the op because VCF paramId 3
   * declares no safeRange. The tell is structural: a recipe that wires a cable
   * into a module and then zeroes that module's modulation-depth control has
   * built something that cannot do what it says.
   */
  const NEUTRALIZING_ROLES = /(attenuverter|attenuator|_amount|depth)/i;

  for (const id of EXPECTED_IDS) {
    it(`${id}: no modulation depth is left at its neutral point`, () => {
      const recipe = getRecipe(id);
      const models = aliasModels(recipe);
      // Only modules this recipe actually patches something into: a depth
      // control left at zero on a module with no incoming cable is inert
      // either way, and pinning it is a legitimate "leave this alone".
      const cabledInto = new Set(
        recipe!.operations
          .filter((o) => o.op === "connect")
          .map((o) => ("alias" in o.input.module ? o.input.module.alias : undefined))
          .filter((a): a is string => a !== undefined),
      );

      for (const op of recipe!.operations) {
        if (op.op !== "set_parameter" || typeof op.normalized !== "number") continue;
        const alias = "alias" in op.module ? op.module.alias : undefined;
        if (!alias || !cabledInto.has(alias)) continue;
        const m = models.get(alias)!;
        const role = getAdapter(m.pluginSlug, m.modelSlug)?.params.find(
          (p) => p.paramId === op.paramId,
        )?.role;
        if (!role || !NEUTRALIZING_ROLES.test(role)) continue;

        const gt = gtByModel.get(`${m.pluginSlug} ${m.modelSlug}`)!.params.find(
          (p) => p.paramId === op.paramId,
        )!;
        const raw = rawFromNormalized(gt, op.normalized);
        expect(
          Math.abs(raw),
          `${id} ${alias} (${m.pluginSlug}/${m.modelSlug}) p${op.paramId} "${gt.name}" role ` +
            `"${role}": normalized ${op.normalized} decodes to raw ${raw} on range ` +
            `[${gt.minValue}, ${gt.maxValue}] -- that is the neutral position, so the cable ` +
            `this recipe patches into ${alias} delivers nothing`,
        ).toBeGreaterThan(1e-6);
      }
    });
  }
});

describe("recipe resolution and expansion", () => {
  /** All preferred models of a recipe, as an installed set. */
  function installedFor(id: string): InstalledModel[] {
    return getRecipe(id)!.roles.map((r) => ({ ...r.preferred }));
  }

  it("resolves when every preferred model is installed and expands with substituted models", () => {
    for (const id of EXPECTED_IDS) {
      const recipe = getRecipe(id)!;
      const resolution = resolveRecipe(recipe, installedFor(id));
      expect(resolution.resolved, `${id} resolves`).toBe(true);
      expect(resolution.unresolvedRoles.length).toBe(0);

      const expanded = expandRecipeOperations(recipe, resolution);
      // No placeholder plugin slug survives expansion, and every add_module now
      // names a real installed model.
      const installed = installedFor(id);
      for (const op of expanded) {
        if (op.op === "add_module") {
          expect(op.pluginSlug).not.toBe("$role");
          expect(
            installed.some((m) => m.pluginSlug === op.pluginSlug && m.modelSlug === op.modelSlug),
            `${id} expanded add_module ${op.pluginSlug}/${op.modelSlug} is installed`,
          ).toBe(true);
        }
      }
    }
  });

  it("reports an unresolved role and refuses expansion when a preferred model is missing", () => {
    const recipe = getRecipe("basic_mono_subtractive")!;
    // Install everything except the oscillator.
    const installed = recipe.roles
      .filter((r) => r.role !== "oscillator")
      .map((r) => ({ ...r.preferred }));
    const resolution = resolveRecipe(recipe, installed);
    expect(resolution.resolved).toBe(false);
    expect(resolution.unresolvedRoles.map((u) => u.role)).toContain("oscillator");
    expect(() => expandRecipeOperations(recipe, resolution)).toThrow(/not fully resolved/);
  });

  it("only offers adapter-verified installed alternatives, never a silent substitute", () => {
    // A recipe whose preferred is missing but which lists an adapter-verified
    // alternative should surface that alternative only when it is installed.
    const base = getRecipe("basic_mono_subtractive")!;
    const withAlt = Recipe.parse({
      ...base,
      id: "test_alt_recipe",
      roles: base.roles.map((r) =>
        r.role === "amplifier"
          ? { ...r, preferred: { pluginSlug: "Fundamental", modelSlug: "VCA-1" }, adapterVerifiedAlternatives: [{ pluginSlug: "Fundamental", modelSlug: "VCA" }] }
          : r,
      ),
    });
    // Install the alternative (Fundamental/VCA) but not the preferred VCA-1.
    const installed = withAlt.roles.map((r) =>
      r.role === "amplifier" ? { pluginSlug: "Fundamental", modelSlug: "VCA" } : { ...r.preferred },
    );
    const resolution = resolveRecipe(withAlt, installed);
    const amp = resolution.unresolvedRoles.find((u) => u.role === "amplifier");
    expect(amp, "amplifier is unresolved (preferred missing)").toBeDefined();
    expect(amp!.installedAlternatives).toContainEqual({ pluginSlug: "Fundamental", modelSlug: "VCA" });
  });
});

describe("adapter pack is available to the resolver", () => {
  it("has adapters loaded", () => {
    expect(listAdapters().length).toBeGreaterThan(0);
  });
});
