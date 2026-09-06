import { z } from "zod";
import { PatchOperation } from "./operations.js";
import { SignalRole } from "./adapters.js";
import { Slug } from "./refs.js";

/** Versioned high-level recipes (spec section 11). */

export const RecipeRoleRequirement = z
  .object({
    /** Functional role key, e.g. "oscillator", "filter", "midi_input". */
    role: z.string().max(64),
    description: z.string().max(1024),
    /** Preferred concrete model. */
    preferred: z.object({ pluginSlug: Slug, modelSlug: Slug }).strict(),
    signalRoles: z.array(SignalRole).default([]),
  })
  .strict();

export const Recipe = z
  .object({
    recipeVersion: z.literal(1),
    id: z.string().regex(/^[a-z0-9_]+$/).max(64),
    name: z.string().max(256),
    description: z.string().max(4096),
    roles: z.array(RecipeRoleRequirement).max(64),
    /**
     * Operation template: PatchOperations whose add_module slugs may reference
     * roles using the placeholder pluginSlug "$role" and modelSlug "<roleKey>",
     * resolved against installed models at expansion time.
     */
    operations: z.array(PatchOperation).max(128),
    notes: z.array(z.string().max(1024)).default([]),
  })
  .strict();
export type Recipe = z.infer<typeof Recipe>;

export const RecipeResolution = z
  .object({
    recipeId: z.string().max(64),
    resolved: z.boolean(),
    /** Roles that could not be satisfied by installed models. */
    unresolvedRoles: z.array(
      z
        .object({
          role: z.string().max(64),
          description: z.string().max(1024),
          /**
           * The model that would satisfy this role. Reported so the client can
           * say what to install rather than only that something is missing.
           */
          preferred: z.object({ pluginSlug: Slug, modelSlug: Slug }).strict(),
        })
        .strict(),
    ),
    /** Concrete role -> model assignments for resolved roles. */
    assignments: z.record(z.string(), z.object({ pluginSlug: Slug, modelSlug: Slug }).strict()),
  })
  .strict();
export type RecipeResolution = z.infer<typeof RecipeResolution>;
