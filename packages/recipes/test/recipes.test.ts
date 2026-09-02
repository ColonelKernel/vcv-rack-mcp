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
