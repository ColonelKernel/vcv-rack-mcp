import { z } from "zod";

/**
 * Rollback report attached to failed transaction commits (spec section 6).
 * Defined here (not bridge.ts) so RackMcpError can embed it without cycles.
 */
export const RollbackReport = z
  .object({
    rolledBack: z.enum(["complete", "indeterminate"]),
    failedOperationIndex: z.number().int().min(0),
    inversesExecuted: z.number().int().min(0),
    detail: z.string().max(4096),
  })
  .strict();
export type RollbackReport = z.infer<typeof RollbackReport>;

/**
 * Stable Rack MCP error codes (spec section 12). Never renumber or rename;
 * only append. The C++ enum in the generated protocol header mirrors this list.
 */
export const ERROR_CODES = [
  "RACK_NOT_FOUND",
  "RACK_DISCONNECTED",
  "BRIDGE_NOT_READY",
  "WRITER_LEASE_REQUIRED",
  "AUTHENTICATION_FAILED",
  "PROTOCOL_VERSION_MISMATCH",
  "STALE_SESSION",
  "STALE_PATCH_EPOCH",
  "PATCH_CONFLICT",
  "MODEL_NOT_INSTALLED",
  "MODULE_NOT_FOUND",
  "CABLE_NOT_FOUND",
  "PARAMETER_NOT_FOUND",
  "PORT_NOT_FOUND",
  "VALIDATION_FAILED",
  "CONFIRMATION_REQUIRED",
  "CONFIRMATION_EXPIRED",
  "PATH_NOT_ALLOWED",
  "TRANSACTION_TOO_LARGE",
  "ROLLBACK_FAILED",
  "TIMEOUT",
  "UNSUPPORTED_OPERATION",
  "OPAQUE_STATE_UNSUPPORTED",
  "TELEMETRY_UNAVAILABLE",
  // Additional stable codes beyond the spec's non-exhaustive list:
  "BAD_REQUEST",
  "RATE_LIMITED",
  "LEASE_HELD",
  "INSTANCE_NOT_SELECTED",
  "RESULT_TOO_LARGE",
  "INTERNAL",
] as const;

export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** Alias used by consumers that prefer the "RackErrorCode" name. */
export type RackErrorCode = ErrorCode;

const ERROR_CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES);

/** Maps an arbitrary code string to a known error code, defaulting to INTERNAL. */
export function normalizeErrorCode(code: string): ErrorCode {
  return (ERROR_CODE_SET.has(code) ? code : "INTERNAL") as ErrorCode;
}

/**
 * Every Rack MCP error states whether retrying is safe and whether the
 * requested mutation may already have occurred. Mutating retries must reuse
 * the same operation ID so the idempotency cache can suppress reapplication.
 */
export const RackMcpError = z
  .object({
    code: ErrorCode,
    message: z.string().max(4096),
    /** True when the caller may retry without risk of duplicate effects. */
    retrySafe: z.boolean(),
    /** True when the mutation may already have been applied (retry only with the same operationId). */
    mutationMayHaveOccurred: z.boolean(),
    /** Optional machine-readable context (entity refs, rule ids, limits hit...). */
    details: z.record(z.string(), z.unknown()).optional(),
    /**
     * Present on failed commit responses: the spec-required rollback report
     * (inverse execution summary; "indeterminate" when completeness is unproven).
     */
    rollback: RollbackReport.optional(),
  })
  .strict();
export type RackMcpError = z.infer<typeof RackMcpError>;

/** Default retry semantics per error code, used by the normalization layer. */
export const ERROR_DEFAULTS: Record<ErrorCode, { retrySafe: boolean; mutationMayHaveOccurred: boolean }> = {
  RACK_NOT_FOUND: { retrySafe: true, mutationMayHaveOccurred: false },
  RACK_DISCONNECTED: { retrySafe: true, mutationMayHaveOccurred: true },
  BRIDGE_NOT_READY: { retrySafe: true, mutationMayHaveOccurred: false },
  WRITER_LEASE_REQUIRED: { retrySafe: true, mutationMayHaveOccurred: false },
  AUTHENTICATION_FAILED: { retrySafe: false, mutationMayHaveOccurred: false },
  PROTOCOL_VERSION_MISMATCH: { retrySafe: false, mutationMayHaveOccurred: false },
  STALE_SESSION: { retrySafe: false, mutationMayHaveOccurred: false },
  STALE_PATCH_EPOCH: { retrySafe: false, mutationMayHaveOccurred: false },
  PATCH_CONFLICT: { retrySafe: false, mutationMayHaveOccurred: false },
  MODEL_NOT_INSTALLED: { retrySafe: false, mutationMayHaveOccurred: false },
  MODULE_NOT_FOUND: { retrySafe: false, mutationMayHaveOccurred: false },
  CABLE_NOT_FOUND: { retrySafe: false, mutationMayHaveOccurred: false },
  PARAMETER_NOT_FOUND: { retrySafe: false, mutationMayHaveOccurred: false },
  PORT_NOT_FOUND: { retrySafe: false, mutationMayHaveOccurred: false },
  VALIDATION_FAILED: { retrySafe: false, mutationMayHaveOccurred: false },
  CONFIRMATION_REQUIRED: { retrySafe: false, mutationMayHaveOccurred: false },
  CONFIRMATION_EXPIRED: { retrySafe: false, mutationMayHaveOccurred: false },
  PATH_NOT_ALLOWED: { retrySafe: false, mutationMayHaveOccurred: false },
  TRANSACTION_TOO_LARGE: { retrySafe: false, mutationMayHaveOccurred: false },
  ROLLBACK_FAILED: { retrySafe: false, mutationMayHaveOccurred: true },
  TIMEOUT: { retrySafe: false, mutationMayHaveOccurred: true },
  UNSUPPORTED_OPERATION: { retrySafe: false, mutationMayHaveOccurred: false },
  OPAQUE_STATE_UNSUPPORTED: { retrySafe: false, mutationMayHaveOccurred: false },
  TELEMETRY_UNAVAILABLE: { retrySafe: true, mutationMayHaveOccurred: false },
  BAD_REQUEST: { retrySafe: false, mutationMayHaveOccurred: false },
  RATE_LIMITED: { retrySafe: true, mutationMayHaveOccurred: false },
  LEASE_HELD: { retrySafe: true, mutationMayHaveOccurred: false },
  INSTANCE_NOT_SELECTED: { retrySafe: true, mutationMayHaveOccurred: false },
  RESULT_TOO_LARGE: { retrySafe: false, mutationMayHaveOccurred: false },
  INTERNAL: { retrySafe: false, mutationMayHaveOccurred: true },
};
