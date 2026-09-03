import { describe, expect, it } from "vitest";
import { ERROR_DEFAULTS, RackMcpError } from "@rackmcp/schemas";
import { ToolError, toErrorPayload } from "../src/errors.js";

describe("error payloads stay within their published contract", () => {
  /**
   * The error payload is a contract in its own right — stable codes plus the
   * retrySafe / mutationMayHaveOccurred flags a client steers retries by — but
   * nothing validated it until now. An over-long message put it off-contract
   * exactly when something had already gone wrong.
   */
  it("clamps an over-long message instead of emitting an invalid payload", () => {
    const payload = toErrorPayload(new Error("x".repeat(9000)));
    const parsed = RackMcpError.safeParse(payload);
    expect(parsed.success).toBe(true);
    expect(payload.message.length).toBeLessThanOrEqual(4096);
    expect(payload.message.endsWith("... [truncated]")).toBe(true);
  });

  it("leaves a normal message untouched", () => {
    const payload = toErrorPayload(new ToolError("PATH_NOT_ALLOWED", "nope", true, false));
    expect(payload.message).toBe("nope");
    expect(RackMcpError.safeParse(payload).success).toBe(true);
  });

  it("produces a schema-valid payload for a non-Error throw", () => {
    const parsed = RackMcpError.safeParse(toErrorPayload({ weird: "object" }));
    expect(parsed.success).toBe(true);
  });

  it("produces a schema-valid payload for every error code's defaults", () => {
    for (const code of Object.keys(ERROR_DEFAULTS) as Array<keyof typeof ERROR_DEFAULTS>) {
      const d = ERROR_DEFAULTS[code];
      const payload = toErrorPayload(
        new ToolError(code, `failure for ${code}`, d.retrySafe, d.mutationMayHaveOccurred),
      );
      const parsed = RackMcpError.safeParse(payload);
      expect(parsed.success, `${code}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
      expect(payload.code).toBe(code);
    }
  });
});
