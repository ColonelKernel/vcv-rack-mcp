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
    /**
     * Finite samples actually accumulated into `sum` and `sumSquares`.
     *
     * Not the same as the window length. A channel can start contributing
     * partway through a window -- a cable patched mid-window, or a polyphonic
     * channel count that grows -- and the loop feeding this accumulator only
     * visits channels that exist at the time. `mean` and `rms` used to divide
     * by the window length minus `nonFinite`, so a channel patched five frames
     * before a 2205-frame window closed had its mean divided by 2200 rather
     * than 5, understating it by a factor of 440 in the first reading after
     * anything was plugged in. The comment on that loop already names the
     * mid-window case, for min/max, which is why this was worth noticing.
     */
    uint32_t frames;
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
        frames = 0;
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
        frames++;
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

/**
 * Finalize an accumulator into stats.
 *
 * Averages over the samples this channel actually contributed, which is what
 * `acc.frames` counts -- not the window length. For a channel present for the
 * whole window the two agree exactly (`frames == windowFrames - nonFinite`);
 * they diverge only for a channel that appeared partway through, which is
 * precisely the first reading after a cable is patched.
 */
inline ChannelStats finalizeChannel(const ChannelAccumulator& acc) {
    ChannelStats s;
    s.minV = acc.minV;
    s.maxV = acc.maxV;
    s.peakAbs = acc.peakAbs;
    if (acc.frames > 0) {
        s.mean = (float) (acc.sum / (double) acc.frames);
        s.rms = (float) std::sqrt(acc.sumSquares / (double) acc.frames);
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
