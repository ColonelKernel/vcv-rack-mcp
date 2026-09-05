import { LIMITS } from "@rackmcp/schemas";
import { ToolError } from "./errors.js";

/**
 * Parameter-change rate limiting (spec section 13, threat model "bounded blast
 * radius": "parameter changes are rate-limited to 30/s per client
 * (`RATE_LIMITED`)").
 *
 * Nothing implemented this. `LIMITS.paramChangesPerSecond` was exported and
 * mirrored into the generated C++ header, and `RATE_LIMITED` sat in the error
 * enum with its retry semantics declared, but no code path ever read the limit
 * or produced the code -- so a client could drive parameter changes at whatever
 * rate it could issue requests, against a documented cap of 30/s.
 *
 * A sliding window rather than a fixed one: a fixed window lets a client land
 * `2 * limit` changes across a boundary, which is exactly the burst the limit
 * exists to prevent. The window holds at most `limit` timestamps, so its cost
 * is bounded by the limit and not by the request rate.
 *
 * This server speaks to one MCP client over stdio, so "per client" is the
 * process. A single counter is the whole implementation of that.
 */
export class RateLimiter {
  private readonly hits: number[] = [];

  constructor(
    private readonly limit: number = LIMITS.paramChangesPerSecond,
    private readonly windowMs: number = 1000,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Records `count` parameter changes, or throws RATE_LIMITED without recording
   * any of them.
   *
   * All-or-nothing on purpose: a transaction is applied as one history action,
   * so admitting part of a batch would either misreport what happened or
   * require splitting an atomic commit.
   */
  admit(count: number): void {
    if (count <= 0 || this.limit <= 0) return;
    const cutoff = this.now() - this.windowMs;
    while (this.hits.length > 0 && this.hits[0]! <= cutoff) this.hits.shift();
    if (this.hits.length + count > this.limit) {
      const retryInMs = this.hits.length > 0 ? Math.max(1, this.hits[0]! + this.windowMs - this.now()) : 1;
      throw new ToolError(
        "RATE_LIMITED",
        `parameter changes are limited to ${this.limit} per second; this request would make ` +
          `${this.hits.length + count}. Retry in about ${retryInMs} ms.`,
        // Retry-safe: nothing was applied, and waiting out the window is the fix.
        true,
        false,
        { limit: this.limit, windowMs: this.windowMs, retryInMs },
      );
    }
    const at = this.now();
    for (let i = 0; i < count; i++) this.hits.push(at);
  }

  /** Parameter-changing operations in a plan, for admit(). */
  static countParamChanges(operations: readonly unknown[]): number {
    return operations.filter((o) => (o as { op?: string } | null)?.op === "set_parameter").length;
  }
}
