import { Recipe, RecipeResolution } from "@rackmcp/schemas";
import type { PatchOperation } from "@rackmcp/schemas";
import { hasAdapter } from "@rackmcp/adapters";
import { RECIPE_DOCS } from "./data.js";

/**
 * Versioned high-level recipes (spec section 11). Each recipe declares the
 * functional roles it needs, a preferred concrete model per role, and an
 * operation template. Resolution binds roles to installed models; an exact
 * dependency that is missing is reported as an unresolved role — with
 * adapter-verified installed alternatives when any exist — and never silently
 * substituted.
 *
 * Operation templates reference roles with the placeholder pluginSlug "$role"
 * and modelSlug set to the role key; expandRecipeOperations() substitutes the
 * resolved concrete models before the operations reach the preview/commit path.
 */

export type { Recipe, RecipeResolution };

const RECIPES: ReadonlyArray<Recipe> = RECIPE_DOCS.map((doc, i) => {
  const parsed = Recipe.safeParse(doc);
  if (!parsed.success) {
    throw new Error(
      `Invalid recipe at index ${i}: ${JSON.stringify(parsed.error.issues.slice(0, 4))}`,
    );
  }
  return parsed.data;
});

const BY_ID = new Map<string, Recipe>(RECIPES.map((r) => [r.id, r]));
if (BY_ID.size !== RECIPES.length) {
  throw new Error("Duplicate recipe id in registry");
}

export function listRecipes(): ReadonlyArray<Recipe> {
  return RECIPES;
}

export const RECIPE_COUNT = RECIPES.length;

export function getRecipe(id: string): Recipe | undefined {
  return BY_ID.get(id);
}

export interface InstalledModel {
  pluginSlug: string;
  modelSlug: string;
}

const ROLE_PLUGIN = "$role";

function installedHas(installed: ReadonlyArray<InstalledModel>, m: InstalledModel): boolean {
  return installed.some((x) => x.pluginSlug === m.pluginSlug && x.modelSlug === m.modelSlug);
}

/**
 * Resolve a recipe's roles against the installed models. A role resolves to its
 * preferred model when installed; otherwise the role is unresolved and any
 * installed, adapter-verified alternatives are listed (compatibility must be
 * proven by an adapter — an installed alternative with no adapter is not
 * offered). Never substitutes an unknown module.
 */
export function resolveRecipe(
  recipe: Recipe,
  installed: ReadonlyArray<InstalledModel>,
): RecipeResolution {
  const assignments: Record<string, InstalledModel> = {};
  const unresolvedRoles: RecipeResolution["unresolvedRoles"] = [];

  for (const role of recipe.roles) {
    if (installedHas(installed, role.preferred)) {
      assignments[role.role] = { ...role.preferred };
      continue;
    }
    const installedAlternatives = role.adapterVerifiedAlternatives.filter(
      (alt) => installedHas(installed, alt) && hasAdapter(alt.pluginSlug, alt.modelSlug),
    );
    unresolvedRoles.push({
      role: role.role,
      description: role.description,
      installedAlternatives,
    });
  }

  return RecipeResolution.parse({
    recipeId: recipe.id,
    resolved: unresolvedRoles.length === 0,
    unresolvedRoles,
    assignments,
  });
}

/**
 * Expand a fully-resolved recipe's operation template into concrete
 * PatchOperations by substituting the role placeholders (`$role`/<roleKey>) with
 * the assigned models. Throws if the resolution is incomplete or references an
 * unknown role, so a partial recipe can never reach the mutation path.
 */
export function expandRecipeOperations(
  recipe: Recipe,
  resolution: RecipeResolution,
): PatchOperation[] {
  if (!resolution.resolved) {
    throw new Error(`Recipe ${recipe.id} is not fully resolved; cannot expand operations`);
  }
  const subst = (pluginSlug: string, modelSlug: string): { pluginSlug: string; modelSlug: string } => {
    if (pluginSlug !== ROLE_PLUGIN) return { pluginSlug, modelSlug };
    const assigned = resolution.assignments[modelSlug];
    if (!assigned) throw new Error(`Recipe ${recipe.id} references unassigned role "${modelSlug}"`);
    return { pluginSlug: assigned.pluginSlug, modelSlug: assigned.modelSlug };
  };
  return recipe.operations.map((op) => {
    if (op.op === "add_module") {
      const { pluginSlug, modelSlug } = subst(op.pluginSlug, op.modelSlug);
      return { ...op, pluginSlug, modelSlug };
    }
    return op;
  });
}
