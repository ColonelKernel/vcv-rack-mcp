import { BridgeRequestError } from "@rackmcp/protocol";
import { normalizeErrorCode, type RackErrorCode } from "@rackmcp/schemas";

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
    return {
      code: normalizeErrorCode(err.rpcError.code),
      message: err.rpcError.message,
      retrySafe: err.rpcError.retrySafe,
      mutationMayHaveOccurred: err.rpcError.mutationMayHaveOccurred,
    };
  }
  return {
    code: "INTERNAL",
    message: err instanceof Error ? err.message : String(err),
    retrySafe: false,
    mutationMayHaveOccurred: false,
  };
}
