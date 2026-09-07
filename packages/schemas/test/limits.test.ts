import { describe, expect, it } from "vitest";
import { BRIDGE_PROTOCOL_MIN_SUPPORTED, BRIDGE_PROTOCOL_VERSION, LIMITS } from "../src/limits.js";

/**
 * LIMITS is the single source of truth for both halves of the system: every
 * entry is generated into a C++ `static const int64_t` by scripts/gen-cpp.ts.
 * That imposes a contract on the values themselves, and nothing checked it.
 */
describe("limits", () => {
  it("every limit is a safe non-negative integer", () => {
    // A fractional limit narrows silently on the way into int64_t, so C++ would
    // hold a truncated constant while TypeScript held the fraction. This is
    // reachable: probeMaxHz is computed from probeWindowMs, so setting the
    // window to 30 ms makes the rate 33.33.
    const bad = Object.entries(LIMITS).filter(
      ([, v]) => !Number.isSafeInteger(v) || (v as number) < 0,
    );
    expect(bad.map(([k, v]) => `${k} = ${String(v)}`)).toEqual([]);
  });

  it("the probe republish rate is the window length, not a second opinion", () => {
    // read_probe's published description interpolates both numbers into one
    // sentence. If they disagreed, the tool would be describing a rate at which
    // no window is ever produced.
    expect(LIMITS.probeMaxHz).toBe(1000 / LIMITS.probeWindowMs);
  });

  it("the protocol floor is not above the current version", () => {
    // A floor above the version accepts nothing at all, and the handshake would
    // reject every client including this repo's own.
    expect(BRIDGE_PROTOCOL_MIN_SUPPORTED).toBeLessThanOrEqual(BRIDGE_PROTOCOL_VERSION);
    expect(BRIDGE_PROTOCOL_MIN_SUPPORTED).toBeGreaterThan(0);
  });

  it("timeouts and sizes are positive, since zero disables rather than restricts", () => {
    // A zero byte cap or a zero timeout does not mean "no limit" anywhere in
    // this codebase -- it means every frame is oversized or every call times
    // out immediately.
    for (const key of [
      "bridgeFrameBytes",
      "mcpResultBytes",
      "commandTimeoutMs",
      "patchIoTimeoutMs",
      "txnCommitTimeoutMs",
      "probeWindowMs",
      "txnMaxOperations",
    ] as const) {
      expect(LIMITS[key], key).toBeGreaterThan(0);
    }
  });
});
