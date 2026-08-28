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

export const ValidationFinding = z
  .object({
    /** Stable rule id, e.g. "structural.port_index_bounds". Never renamed. */
    ruleId: z.string().regex(/^[a-z0-9_.]+$/).max(128),
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
