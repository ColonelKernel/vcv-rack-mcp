#include "rackside/ProbeModule.hpp"

#include "gen/rackmcp_protocol_gen.hpp"
#include "rackmcp_plugin.hpp"

#include <cmath>

namespace rackmcp {

using namespace rack;

ProbeModule::ProbeModule() {
    config(PARAMS_LEN, INPUTS_LEN, OUTPUTS_LEN, LIGHTS_LEN);
    for (int i = 0; i < NUM_PROBE_INPUTS; i++)
        configInput(PROBE1_INPUT + i, string::f("Probe %d", i + 1));
    for (int i = 0; i < NUM_PROBE_INPUTS; i++)
        for (int c = 0; c < PROBE_MAX_CHANNELS; c++)
            acc_[i][c].resetAll();
    lightDivider_.setDivision(512);
    beginWindow();
}

void ProbeModule::beginWindow() {
    windowFrame_ = 0;
    for (int i = 0; i < NUM_PROBE_INPUTS; i++) {
        windowChannels_[i] = 0;
        channelSeen_[i] = 0;
        for (int c = 0; c < PROBE_MAX_CHANNELS; c++)
            acc_[i][c].reset();
    }
}

void ProbeModule::onSampleRateChange(const SampleRateChangeEvent& e) {
    sampleRate_ = e.sampleRate;
    windowTarget_ = (uint32_t) (e.sampleRate * (float) gen::LIMIT_PROBE_WINDOW_MS / 1000.f);
    if (windowTarget_ < 64)
        windowTarget_ = 64;
    beginWindow();
}

void ProbeModule::process(const ProcessArgs& args) {
    // Fixed-cost accumulation; no allocation, locks, IO, or JSON here.
    for (int i = 0; i < NUM_PROBE_INPUTS; i++) {
        engine::Input& input = inputs[PROBE1_INPUT + i];
        uint8_t channels = (uint8_t) input.getChannels();
        if (channels > PROBE_MAX_CHANNELS)
            channels = PROBE_MAX_CHANNELS;
        if (channels > windowChannels_[i])
            windowChannels_[i] = channels;
        // `first` is per channel, not per window: a cable patched mid-window, or
        // a poly channel count that grows, must seed min/max from its own first
        // finite sample rather than clamp against the 0 V reset seed.
        uint16_t seen = channelSeen_[i];
        for (uint8_t c = 0; c < channels; c++) {
            uint16_t bit = (uint16_t) (1u << c);
            bool first = (seen & bit) == 0;
            float v = input.getVoltage(c);
            acc_[i][c].accumulate(v, first);
            if (first && std::isfinite(v))
                seen |= bit;
        }
        channelSeen_[i] = seen;
    }
    windowFrame_++;

    if (windowFrame_ >= windowTarget_) {
        sequence_++;
        for (int i = 0; i < NUM_PROBE_INPUTS; i++) {
            ProbeWindowSnapshot snap;
            snap.sequence = sequence_;
            snap.windowFrames = windowFrame_;
            snap.sampleRate = args.sampleRate;
            snap.channelCount = windowChannels_[i];
            for (int c = 0; c < PROBE_MAX_CHANNELS; c++) {
                if (c < windowChannels_[i])
                    snap.channels[c] = finalizeChannel(acc_[i][c], windowFrame_);
                else
                    snap.channels[c] = ChannelStats();
            }
            published[i].publish(snap);
        }
        beginWindow();
    }

    if (lightDivider_.process()) {
        for (int i = 0; i < NUM_PROBE_INPUTS; i++) {
            bool connected = inputs[PROBE1_INPUT + i].isConnected();
            lights[PROBE_LIGHT + i * 2 + 0].setBrightness(connected ? 1.f : 0.f);
            lights[PROBE_LIGHT + i * 2 + 1].setBrightness(0.f);
        }
    }
}

struct ProbeWidget : app::ModuleWidget {
    explicit ProbeWidget(ProbeModule* module) {
        setModule(module);
        setPanel(createPanel(asset::plugin(pluginInstance, "res/Probe.svg")));

        addChild(createWidget<componentlibrary::ThemedScrew>(math::Vec(RACK_GRID_WIDTH, 0)));
        addChild(createWidget<componentlibrary::ThemedScrew>(
            math::Vec(box.size.x - 2 * RACK_GRID_WIDTH, RACK_GRID_HEIGHT - RACK_GRID_WIDTH)));

        for (int i = 0; i < ProbeModule::NUM_PROBE_INPUTS; i++) {
            float y = 24.f + i * 11.5f;
            addInput(createInputCentered<componentlibrary::ThemedPJ301MPort>(
                mm2px(math::Vec(12.f, y)), module, ProbeModule::PROBE1_INPUT + i));
            addChild(createLightCentered<componentlibrary::MediumLight<componentlibrary::GreenRedLight>>(
                mm2px(math::Vec(24.f, y)), module, ProbeModule::PROBE_LIGHT + i * 2));
        }
    }

    void draw(const DrawArgs& args) override {
        ModuleWidget::draw(args);
        // Runtime-rendered labels (panel SVGs carry no text for nanosvg).
        std::shared_ptr<window::Font> font = APP->window->loadFont(
            asset::system("res/fonts/ShareTechMono-Regular.ttf"));
        if (font) {
            nvgFontFaceId(args.vg, font->handle);
            nvgFillColor(args.vg, nvgRGB(0xe6, 0xe6, 0xe6));
            nvgFontSize(args.vg, 13.f);
            nvgTextAlign(args.vg, NVG_ALIGN_CENTER | NVG_ALIGN_MIDDLE);
            nvgText(args.vg, box.size.x / 2.f, mm2px(7.f), "MCP PROBE", NULL);
            nvgFontSize(args.vg, 10.f);
            for (int i = 0; i < ProbeModule::NUM_PROBE_INPUTS; i++) {
                float y = 24.f + i * 11.5f;
                nvgText(args.vg, mm2px(31.f), mm2px(y), string::f("%d", i + 1).c_str(), NULL);
            }
        }
    }
};

} // namespace rackmcp

rack::plugin::Model* modelProbe =
    rack::createModel<rackmcp::ProbeModule, rackmcp::ProbeWidget>("Probe");
