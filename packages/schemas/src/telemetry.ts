import { z } from "zod";
import { DecimalId, SmallIndex } from "./refs.js";

/** Probe telemetry (spec section 8, Telemetry). */

export const ProbeChannelStats = z
  .object({
    min: z.number(),
    max: z.number(),
    peakAbs: z.number(),
    rms: z.number(),
    /** Mean / DC component. */
    mean: z.number(),
    clippedCount: z.number().int().min(0),
    nonFiniteCount: z.number().int().min(0),
    /** Rising-edge count using gate thresholds (low<=0.1V, high>=1.0V); optional. */
    edgeCount: z.number().int().min(0).optional(),
  })
  .strict();
export type ProbeChannelStats = z.infer<typeof ProbeChannelStats>;

export const ProbeReading = z
  .object({
    probeModuleId: DecimalId,
    probeInputId: SmallIndex,
    connected: z.boolean(),
    channelCount: z.number().int().min(0).max(16),
    sampleRate: z.number().positive(),
    windowFrames: z.number().int().min(0),
    channels: z.array(ProbeChannelStats).max(16),
    /** Count of telemetry frames dropped since attach (UI thread fell behind). */
    droppedFrames: z.number().int().min(0),
    /** Monotonic sequence number of this published window. */
    sequence: z.number().int().min(0),
  })
  .strict();
export type ProbeReading = z.infer<typeof ProbeReading>;

export const ProbeSlotInfo = z
  .object({
    probeModuleId: DecimalId,
    probeInputId: SmallIndex,
    connected: z.boolean(),
    /** Source feeding this probe input, if connected. */
    sourceModuleId: DecimalId.optional(),
    sourcePortId: SmallIndex.optional(),
  })
  .strict();
export type ProbeSlotInfo = z.infer<typeof ProbeSlotInfo>;
