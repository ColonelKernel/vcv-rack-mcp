import { describe, expect, it } from "vitest";
import { LIMITS } from "@rackmcp/schemas";
import { RateLimiter } from "../src/ratelimit.js";
import { ToolError } from "../src/errors.js";

/**
 * The threat model promises "parameter changes are rate-limited to 30/s per
 * client (`RATE_LIMITED`)". Nothing implemented it: the limit was exported and
 * mirrored into the generated C++ header, `RATE_LIMITED` sat in the error enum
 * with its retry semantics declared, and no code path read either.
 */

/** A clock the test drives, so the window is exercised without sleeping. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("RateLimiter", () => {
  it("admits up to the limit within one window", () => {
    const c = fakeClock();
    const rl = new RateLimiter(30, 1000, c.now);
    for (let i = 0; i < 30; i++) rl.admit(1);
    expect(() => rl.admit(1)).toThrow(ToolError);
  });

  it("rejects with RATE_LIMITED and retry-safe semantics", () => {
    const c = fakeClock();
    const rl = new RateLimiter(2, 1000, c.now);
    rl.admit(2);
    try {
      rl.admit(1);
      throw new Error("expected RATE_LIMITED");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      const err = e as ToolError;
      expect(err.code).toBe("RATE_LIMITED");
      // Nothing was applied and waiting is the fix, so a retry is safe.
      expect(err.retrySafe).toBe(true);
      expect(err.mutationMayHaveOccurred).toBe(false);
      expect(err.details?.limit).toBe(2);
    }
  });

  it("records nothing when it rejects, so a refused batch does not consume budget", () => {
    const c = fakeClock();
    const rl = new RateLimiter(10, 1000, c.now);
    rl.admit(8);
    expect(() => rl.admit(5)).toThrow(); // 8 + 5 > 10
    // The refused 5 must not have been charged: 2 remain.
    expect(() => rl.admit(2)).not.toThrow();
    expect(() => rl.admit(1)).toThrow();
  });

  it("is all-or-nothing on a batch", () => {
    // A transaction lands as one history action, so admitting part of a batch
    // would either misreport what happened or split an atomic commit.
    const c = fakeClock();
    const rl = new RateLimiter(30, 1000, c.now);
    expect(() => rl.admit(31)).toThrow();
    // ...and having refused, the whole budget is still available.
    expect(() => rl.admit(30)).not.toThrow();
  });

  it("slides the window rather than resetting it on a boundary", () => {
    // A fixed window would let 2x the limit land either side of a boundary --
    // exactly the burst the limit exists to prevent.
    const c = fakeClock();
    const rl = new RateLimiter(10, 1000, c.now);
    rl.admit(10);
    c.advance(999);
    expect(() => rl.admit(1)).toThrow();
    c.advance(2); // the first batch is now outside the window
    expect(() => rl.admit(10)).not.toThrow();
  });

  it("frees capacity gradually as individual hits age out", () => {
    const c = fakeClock();
    const rl = new RateLimiter(4, 1000, c.now);
    rl.admit(2);
    c.advance(600);
    rl.admit(2);
    expect(() => rl.admit(1)).toThrow();
    c.advance(500); // the first two age out, the later two do not
    expect(() => rl.admit(2)).not.toThrow();
    expect(() => rl.admit(1)).toThrow();
  });

  it("does nothing for a non-parameter plan or a disabled limit", () => {
    const c = fakeClock();
    expect(() => new RateLimiter(30, 1000, c.now).admit(0)).not.toThrow();
    const off = new RateLimiter(0, 1000, c.now);
    for (let i = 0; i < 1000; i++) off.admit(10);
  });

  it("defaults to the published limit", () => {
    expect(LIMITS.paramChangesPerSecond).toBe(30);
    const c = fakeClock();
    const rl = new RateLimiter(undefined, undefined, c.now);
    expect(() => rl.admit(LIMITS.paramChangesPerSecond)).not.toThrow();
    expect(() => rl.admit(1)).toThrow();
  });
});

describe("RateLimiter.countParamChanges", () => {
  it("counts only set_parameter operations", () => {
    expect(
      RateLimiter.countParamChanges([
        { op: "set_parameter", paramId: 1 },
        { op: "add_module" },
        { op: "set_parameter", paramId: 2 },
        { op: "connect" },
      ]),
    ).toBe(2);
  });

  it("tolerates malformed entries rather than throwing", () => {
    expect(RateLimiter.countParamChanges([null, undefined, 7, "x", {}])).toBe(0);
  });
});
