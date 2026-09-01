#pragma once
// RackMCP-Probe: signal-analysis module. DSP performs fixed-cost accumulation
// only and publishes windows through lock-free seqlock buffers. Telemetry is
// available exclusively for signals patched into these inputs (spec: no
// arbitrary output sampling without an explicit Probe cable).
#include <rack.hpp>

#include "core/queues.hpp"
#include "core/telemetry.hpp"

namespace rackmcp {

struct ProbeModule : rack::engine::Module {
    enum ParamId { PARAMS_LEN };
    enum InputId { PROBE1_INPUT, PROBE2_INPUT, PROBE3_INPUT, PROBE4_INPUT, PROBE5_INPUT,
                   PROBE6_INPUT, PROBE7_INPUT, PROBE8_INPUT, INPUTS_LEN };
    enum OutputId { OUTPUTS_LEN };
    enum LightId { ENUMS(PROBE_LIGHT, 8 * 2), LIGHTS_LEN };

    static const int NUM_PROBE_INPUTS = 8;

    ProbeModule();
    void process(const ProcessArgs& args) override;
    void onSampleRateChange(const SampleRateChangeEvent& e) override;

    /** Lock-free published windows, one per probe input. Read from UI thread. */
    TelemetrySnapshotBuffer<ProbeWindowSnapshot> published[NUM_PROBE_INPUTS];

private:
    void beginWindow();

    ChannelAccumulator acc_[NUM_PROBE_INPUTS][PROBE_MAX_CHANNELS];
    uint8_t windowChannels_[NUM_PROBE_INPUTS] = {};
    uint32_t windowFrame_ = 0;
    uint32_t windowTarget_ = 2205;
    uint32_t sequence_ = 0;
    float sampleRate_ = 44100.f;
    rack::dsp::ClockDivider lightDivider_;
};

} // namespace rackmcp
