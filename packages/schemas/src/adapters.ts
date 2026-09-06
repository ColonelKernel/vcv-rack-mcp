import { z } from "zod";
import { SmallIndex, Slug } from "./refs.js";

/**
 * Versioned module adapter documents (spec section 3.4). Adapters carry
 * verified semantics for specific plugin/model versions. Anything not covered
 * by an adapter must be reported with confidence "heuristic".
 */

export const SignalRole = z.enum([
  "audio",
  "cv_unipolar",
  "cv_bipolar",
  "pitch_voct",
  "gate",
  "trigger",
  "clock",
  "unknown",
]);
export type SignalRole = z.infer<typeof SignalRole>;

export const PolyphonyBehavior = z.enum([
  "monophonic",
  "polyphonic",
  "poly_from_input",
  "unknown",
]);

export const AdapterParamSemantics = z
  .object({
    paramId: SmallIndex,
    /** Stable semantic key, e.g. "frequency", "cutoff", "attack". */
    role: z.string().max(64),
    description: z.string().max(1024).optional(),
    /** Safe value to use when initializing a fresh patch. */
    safeInitial: z.number().optional(),
    /** Values outside this range are flagged by validation (raw units). */
    safeRange: z.tuple([z.number(), z.number()]).optional(),
  })
  .strict();

export const AdapterPortSemantics = z
  .object({
    portId: SmallIndex,
    role: SignalRole,
    /** Stable semantic key, e.g. "pitch_in", "audio_out_l". */
    key: z.string().max(64),
    description: z.string().max(1024).optional(),
    polyphony: PolyphonyBehavior.default("unknown"),
  })
  .strict();

export const AdapterConnectionRecipe = z
  .object({
    name: z.string().max(128),
    description: z.string().max(2048),
    /** From this module's output key to another semantic input role. */
    fromOutputKey: z.string().max(64),
    toRole: SignalRole,
  })
  .strict();

export const ModuleAdapter = z
  .object({
    /** Adapter document schema version. */
    adapterVersion: z.literal(1),
    pluginSlug: Slug,
    modelSlug: Slug,
    /** Semver range of plugin versions this adapter has been verified against. */
    pluginVersionRange: z.string().max(128),
    displayName: z.string().max(256),
    summary: z.string().max(2048),
    params: z.array(AdapterParamSemantics).max(1024),
    inputs: z.array(AdapterPortSemantics).max(256),
    outputs: z.array(AdapterPortSemantics).max(256),
    polyphony: PolyphonyBehavior.default("unknown"),
    connectionRecipes: z.array(AdapterConnectionRecipe).max(64).default([]),
    /** Where these semantics were verified (manual URL, source inspection...). */
    provenance: z.array(z.string().max(1024)).min(1),
  })
  .strict();
export type ModuleAdapter = z.infer<typeof ModuleAdapter>;
