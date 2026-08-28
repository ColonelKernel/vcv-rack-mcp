#pragma once
// Probe telemetry accumulation. Fixed-cost per sample, allocation-free,
// no locks. No Rack dependencies; C++11; unit tested out of tree.
#include <cmath>
#include <cstdint>

namespace rackmcp {

static const int PROBE_MAX_CHANNELS = 16;

/** Voltages at or beyond this magnitude count as clipped (Rack convention). */
static const float PROBE_CLIP_VOLTS = 10.f;
/** Schmitt thresholds for gate/trigger rising-edge counting (Rack convention). */
static const float PROBE_GATE_LOW_VOLTS = 0.1f;
static const float PROBE_GATE_HIGH_VOLTS = 1.f;

/** Per-channel running statistics over one measurement window. */
struct ChannelAccumulator {
    float minV;
    float maxV;
    float peakAbs;
    double sum;
    double sumSquares;
    uint32_t clipped;
    uint32_t nonFinite;
    uint32_t risingEdges;
    bool gateHigh;

    void reset() {
        minV = 0.f;
        maxV = 0.f;
        peakAbs = 0.f;
        sum = 0.0;
        sumSquares = 0.0;
        clipped = 0;
        nonFinite = 0;
        risingEdges = 0;
        // gateHigh persists across windows so an edge is not double counted.
    }

    void resetAll() {
        reset();
        gateHigh = false;
    }

    /** Fixed cost; safe for non-finite input. `first` marks the window's first sample. */
    inline void accumulate(float v, bool first) {
        if (!std::isfinite(v)) {
            nonFinite++;
            return;
        }
        if (first || v < minV)
            minV = v;
        if (first || v > maxV)
            maxV = v;
        float a = std::fabs(v);
        if (a > peakAbs)
            peakAbs = a;
        if (a >= PROBE_CLIP_VOLTS)
            clipped++;
        sum += (double) v;
        sumSquares += (double) v * (double) v;
        if (gateHigh) {
            if (v <= PROBE_GATE_LOW_VOLTS)
                gateHigh = false;
        }
        else {
            if (v >= PROBE_GATE_HIGH_VOLTS) {
                gateHigh = true;
                risingEdges++;
            }
        }
    }
};

/** Finalized per-channel statistics for one window. Trivially copyable. */
struct ChannelStats {
    float minV;
    float maxV;
    float peakAbs;
    float rms;
    float mean;
    uint32_t clipped;
    uint32_t nonFinite;
    uint32_t risingEdges;
};

/** Snapshot for one probe input over one window. Trivially copyable POD. */
struct ProbeWindowSnapshot {
    uint32_t sequence;
    uint32_t windowFrames;
    float sampleRate;
    uint8_t channelCount; // 0 = disconnected
    ChannelStats channels[PROBE_MAX_CHANNELS];
};

/** Finalize an accumulator into stats. finiteFrames = frames minus non-finite. */
inline ChannelStats finalizeChannel(const ChannelAccumulator& acc, uint32_t windowFrames) {
    ChannelStats s;
    uint32_t finite = windowFrames > acc.nonFinite ? windowFrames - acc.nonFinite : 0;
    s.minV = acc.minV;
    s.maxV = acc.maxV;
    s.peakAbs = acc.peakAbs;
    if (finite > 0) {
        s.mean = (float) (acc.sum / (double) finite);
        s.rms = (float) std::sqrt(acc.sumSquares / (double) finite);
    }
    else {
        s.mean = 0.f;
        s.rms = 0.f;
    }
    s.clipped = acc.clipped;
    s.nonFinite = acc.nonFinite;
    s.risingEdges = acc.risingEdges;
    return s;
}

} // namespace rackmcp
