import { BridgeRequestError } from "@rackmcp/protocol";
import { normalizeErrorCode, type RackErrorCode, type RollbackReport } from "@rackmcp/schemas";

/** A tool-level error carrying a stable code and safe-retry semantics. */
export class ToolError extends Error {
  constructor(
    public readonly code: RackErrorCode,
    message: string,
    public readonly retrySafe = false,
    public readonly mutationMayHaveOccurred = false,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

/** Normalizes any thrown value into a structured tool error payload. */
export function toErrorPayload(err: unknown): {
  code: RackErrorCode;
  message: string;
  retrySafe: boolean;
  mutationMayHaveOccurred: boolean;
  details?: Record<string, unknown>;
  rollback?: RollbackReport;
} {
  if (err instanceof ToolError) {
    return {
      code: err.code,
      message: err.message,
      retrySafe: err.retrySafe,
      mutationMayHaveOccurred: err.mutationMayHaveOccurred,
      ...(err.details !== undefined ? { details: err.details } : {}),
    };
  }
  if (err instanceof BridgeRequestError) {
    // The plugin's machine-readable context must survive this hop: a failed
    // commit carries the spec-required rollback report, and dropping it here
    // would leave the client unable to tell a clean rollback from an
    // indeterminate one.
    return {
      code: normalizeErrorCode(err.rpcError.code),
      message: err.rpcError.message,
      retrySafe: err.rpcError.retrySafe,
      mutationMayHaveOccurred: err.rpcError.mutationMayHaveOccurred,
      ...(err.rpcError.details !== undefined ? { details: err.rpcError.details } : {}),
      ...(err.rpcError.rollback !== undefined ? { rollback: err.rpcError.rollback } : {}),
    };
  }
  return {
    code: "INTERNAL",
    message: err instanceof Error ? err.message : String(err),
    retrySafe: false,
    mutationMayHaveOccurred: false,
  };
}
