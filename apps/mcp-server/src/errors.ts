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

/**
 * RackMcpError caps `message` at 4096 characters. An arbitrary thrown value
 * carries an arbitrarily long message — a Zod issue list, a bridge failure
 * quoting a long path — which would put the error payload itself off-contract
 * precisely when something has already gone wrong. Clamp, and say so, rather
 * than emit a message the schema rejects.
 */
const MAX_MESSAGE = 4096;
const TRUNCATION_MARK = "... [truncated]";

function clampMessage(message: string): string {
  if (message.length <= MAX_MESSAGE) return message;
  return message.slice(0, MAX_MESSAGE - TRUNCATION_MARK.length) + TRUNCATION_MARK;
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
      message: clampMessage(err.message),
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
      message: clampMessage(err.rpcError.message),
      retrySafe: err.rpcError.retrySafe,
      mutationMayHaveOccurred: err.rpcError.mutationMayHaveOccurred,
      ...(err.rpcError.details !== undefined ? { details: err.rpcError.details } : {}),
      ...(err.rpcError.rollback !== undefined ? { rollback: err.rpcError.rollback } : {}),
    };
  }
  return {
    code: "INTERNAL",
    message: clampMessage(err instanceof Error ? err.message : String(err)),
    retrySafe: false,
    mutationMayHaveOccurred: false,
  };
}
