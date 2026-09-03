import { describe, expect, it } from "vitest";
import { ProbeChannelStats, ProbeReading, ProbeSlotInfo } from "../src/telemetry.js";
import { ProbeListResult } from "../src/bridge.js";

/**
 * The telemetry schemas had no test of any kind, and the bridge fixtures do not
 * reach them: `probe.read` is captured with `channels: []` and `probe.list`
 * with `slots: []`, because the harness launches Rack non-interactively and the
 * engine never steps (see tests/integration/src/probe-smoke.ts). An empty array
 * satisfies `z.array(X)` no matter how wrong `X` is, so every field of
 * ProbeChannelStats and ProbeSlotInfo — the entire substance of `read_probe`
 * and `list_probes` — was unguarded on every platform.
 *
 * These payloads mirror what plugins/RackMCP/src/rackside/Telemetry.cpp
 * actually emits, field for field, so the shape is pinned without needing a
 * live engine.
 */

/** One channel of a +-5V sine, as buildProbeReading emits it (Telemetry.cpp). */
const sineChannel = {
  min: -5.0,
  max: 5.0,
  peakAbs: 5.0,
  rms: 3.5355339,
  mean: 0.0,
  clippedCount: 0,
  nonFiniteCount: 0,
  edgeCount: 0,
};

describe("ProbeChannelStats", () => {
  it("accepts the full stat block the plugin emits", () => {
    expect(ProbeChannelStats.safeParse(sineChannel).success).toBe(true);
  });

  it("accepts a reading with no edge count", () => {
    const { edgeCount: _drop, ...withoutEdges } = sineChannel;
    expect(ProbeChannelStats.safeParse(withoutEdges).success).toBe(true);
  });

  it("rejects an unknown field", () => {
    expect(ProbeChannelStats.safeParse({ ...sineChannel, extra: 1 }).success).toBe(false);
  });

  it("rejects negative counts and missing required stats", () => {
    expect(ProbeChannelStats.safeParse({ ...sineChannel, clippedCount: -1 }).success).toBe(false);
    expect(ProbeChannelStats.safeParse({ ...sineChannel, nonFiniteCount: 1.5 }).success).toBe(false);
    const { rms: _drop, ...missingRms } = sineChannel;
    expect(ProbeChannelStats.safeParse(missingRms).success).toBe(false);
  });
});

describe("ProbeReading", () => {
  const reading = {
    probeModuleId: "4360803558046751",
    probeInputId: 0,
    connected: true,
    channelCount: 1,
    sampleRate: 44100,
    windowFrames: 2205,
    channels: [sineChannel],
    droppedFrames: 0,
    sequence: 42,
  };

  it("accepts a live reading with channel stats", () => {
    expect(ProbeReading.safeParse(reading).success).toBe(true);
  });

  it("accepts the idle-engine reading the plugin emits before any window", () => {
    // The `!have` branch of buildProbeReading: no window published yet. This is
    // the shape the committed probe.read fixture holds, so the fixture gate and
    // this test cover the two branches between them.
    expect(
      ProbeReading.safeParse({
        ...reading,
        connected: false,
        channelCount: 0,
        windowFrames: 0,
        channels: [],
        sequence: 0,
      }).success,
    ).toBe(true);
  });

  it("accepts a full 16-channel polyphonic window and rejects 17", () => {
    const chans = (n: number) => Array.from({ length: n }, () => sineChannel);
    expect(
      ProbeReading.safeParse({ ...reading, channelCount: 16, channels: chans(16) }).success,
    ).toBe(true);
    expect(ProbeReading.safeParse({ ...reading, channelCount: 16, channels: chans(17) }).success).toBe(
      false,
    );
  });

  it("rejects a non-decimal module id, a bad channel, and a zero sample rate", () => {
    expect(ProbeReading.safeParse({ ...reading, probeModuleId: "0x10" }).success).toBe(false);
    expect(
      ProbeReading.safeParse({ ...reading, channels: [{ ...sineChannel, rms: "loud" }] }).success,
    ).toBe(false);
    // sampleRate is .positive(): the plugin substitutes 44100 rather than send 0.
    expect(ProbeReading.safeParse({ ...reading, sampleRate: 0 }).success).toBe(false);
  });
});

describe("ProbeSlotInfo / ProbeListResult", () => {
  const connectedSlot = {
    probeModuleId: "4360803558046751",
    probeInputId: 2,
    connected: true,
    sourceModuleId: "1313036992881189",
    sourcePortId: 0,
  };
  // buildProbeList omits the source fields entirely when the input is idle.
  const idleSlot = { probeModuleId: "4360803558046751", probeInputId: 3, connected: false };

  it("accepts a connected slot carrying its source, and an idle slot without one", () => {
    expect(ProbeSlotInfo.safeParse(connectedSlot).success).toBe(true);
    expect(ProbeSlotInfo.safeParse(idleSlot).success).toBe(true);
  });

  it("rejects a null source rather than an absent one", () => {
    // The plugin omits the key; it never sends null. Pin that, so a producer
    // switching to null fails here instead of silently reaching clients.
    expect(ProbeSlotInfo.safeParse({ ...idleSlot, sourceModuleId: null }).success).toBe(false);
  });

  it("accepts the eight slots one Probe module exposes", () => {
    const slots = Array.from({ length: 8 }, (_, i) => ({ ...idleSlot, probeInputId: i }));
    expect(ProbeListResult.safeParse({ slots }).success).toBe(true);
  });

  it("rejects an unknown field on a slot", () => {
    expect(ProbeSlotInfo.safeParse({ ...connectedSlot, gain: 1 }).success).toBe(false);
  });
});
