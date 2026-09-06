import { z } from "zod";
import { DecimalId, SmallIndex } from "./refs.js";

/** Validation findings (spec section 10). */

export const Severity = z.enum(["error", "warning", "info"]);
export type Severity = z.infer<typeof Severity>;

export const Confidence = z.enum(["certain", "adapter", "heuristic"]);
export type Confidence = z.infer<typeof Confidence>;

export const EntityRef = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("module"), moduleId: DecimalId }).strict(),
  z.object({ kind: z.literal("cable"), cableId: DecimalId }).strict(),
  z
    .object({
      kind: z.literal("port"),
      moduleId: DecimalId,
      portType: z.enum(["input", "output"]),
      portId: SmallIndex,
    })
    .strict(),
  z.object({ kind: z.literal("param"), moduleId: DecimalId, paramId: SmallIndex }).strict(),
  z.object({ kind: z.literal("patch") }).strict(),
]);
export type EntityRef = z.infer<typeof EntityRef>;

/**
 * Every rule `validate_patch` can report, as a closed set.
 *
 * Published so a client can enumerate what was checked. That matters more here
 * than in most registries: a finding-free result means "none of these fired",
 * not "the patch is correct", and several rules stay silent on modules with no
 * adapter. A client that cannot see the list cannot tell those apart.
 *
 * Kept in lockstep with the implementation by a test in the server package that
 * reads analysis.ts and compares the `add(...)` calls against this list.
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

export const ValidationRuleId = z.enum(VALIDATION_RULES);
export type ValidationRuleId = z.infer<typeof ValidationRuleId>;

export const ValidationFinding = z
  .object({
    /** Stable rule id, e.g. "structural.port_index_bounds". Never renamed. */
    ruleId: ValidationRuleId,
    severity: Severity,
    confidence: Confidence,
    entities: z.array(EntityRef).max(64),
    /** Machine-checkable evidence backing the finding. */
    evidence: z.record(z.string(), z.unknown()),
    explanation: z.string().max(4096),
    suggestedRepair: z.string().max(4096).optional(),
  })
  .strict();
export type ValidationFinding = z.infer<typeof ValidationFinding>;

export const ValidationReport = z
  .object({
    findings: z.array(ValidationFinding).max(4096),
    /** Rule ids that ran. */
    rulesRun: z.array(z.string().max(128)).max(1024),
    errorCount: z.number().int().min(0),
    warningCount: z.number().int().min(0),
    infoCount: z.number().int().min(0),
  })
  .strict();
export type ValidationReport = z.infer<typeof ValidationReport>;
