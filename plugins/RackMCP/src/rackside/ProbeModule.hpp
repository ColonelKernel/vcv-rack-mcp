#pragma once
// RackMCP-Probe: signal-analysis module. DSP performs fixed-cost accumulation
// only and publishes windows through lock-free seqlock buffers. Telemetry is
// available exclusively for signals patched into these inputs (spec: no
// arbitrary output sampling without an explicit Probe cable).
#include <rack.hpp>

#include "core/queues.hpp"
#include "core/telemetry.hpp"
#include "gen/rackmcp_protocol_gen.hpp"
#include <cstdint>

namespace rackmcp {

struct ProbeModule : rack::engine::Module {
    enum ParamId { PARAMS_LEN };
    enum InputId { PROBE1_INPUT, PROBE2_INPUT, PROBE3_INPUT, PROBE4_INPUT, PROBE5_INPUT,
                   PROBE6_INPUT, PROBE7_INPUT, PROBE8_INPUT, INPUTS_LEN };
    enum OutputId { OUTPUTS_LEN };
    enum LightId { ENUMS(PROBE_LIGHT, 8 * 2), LIGHTS_LEN };

    static const int NUM_PROBE_INPUTS = 8;

    // The port count is published to clients as LIMITS.probeInputsPerModule and
    // is written out longhand above, because Rack port ids must be an explicit
    // enum. These tie the two together: adding a PROBEn_INPUT without changing
    // the limit, or vice versa, stops the plugin compiling rather than shipping
    // a module whose advertised and actual input counts disagree.
    static_assert(NUM_PROBE_INPUTS == (int) gen::LIMIT_PROBE_INPUTS_PER_MODULE,
                  "probe input count disagrees with LIMITS.probeInputsPerModule");
    static_assert((int) INPUTS_LEN == NUM_PROBE_INPUTS,
                  "InputId enum has a different number of ports than NUM_PROBE_INPUTS");

    ProbeModule();
    void process(const ProcessArgs& args) override;
    void onSampleRateChange(const SampleRateChangeEvent& e) override;

    /** Lock-free published windows, one per probe input. Read from UI thread. */
    TelemetrySnapshotBuffer<ProbeWindowSnapshot> published[NUM_PROBE_INPUTS];

private:
    void beginWindow();

    ChannelAccumulator acc_[NUM_PROBE_INPUTS][PROBE_MAX_CHANNELS];
    /** Bit c set once channel c contributed a finite sample to this window, so
        min/max are seeded from that sample and not from a 0 V that never was. */
    uint16_t channelSeen_[NUM_PROBE_INPUTS] = {};
    static_assert(PROBE_MAX_CHANNELS <= 16, "channelSeen_ bitmask holds 16 channels");
    uint8_t windowChannels_[NUM_PROBE_INPUTS] = {};
    uint32_t windowFrame_ = 0;
    uint32_t windowTarget_ = 2205;
    uint32_t sequence_ = 0;
    float sampleRate_ = 44100.f;
    rack::dsp::ClockDivider lightDivider_;
};

} // namespace rackmcp
