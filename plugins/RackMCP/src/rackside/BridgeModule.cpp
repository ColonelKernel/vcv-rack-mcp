// RackMCP-Bridge: control/status module. The panel shows connection status,
// instance identity, read-only vs writer-lease state, the last operation, and
// a persistence warning; a pairing-reset control rotates the secret.
#include <rack.hpp>

#include "core/frames.hpp"
#include "rackmcp_plugin.hpp"
#include "rackside/CommandPump.hpp"
#include "rackside/RackBridge.hpp"

namespace rackmcp {

using namespace rack;

struct BridgeModule : engine::Module {
    enum ParamId { RESET_PARAM, PARAMS_LEN };
    enum InputId { INPUTS_LEN };
    enum OutputId { OUTPUTS_LEN };
    enum LightId { CONNECTED_LIGHT, LEASE_LIGHT, WARNING_LIGHT, LIGHTS_LEN };

    dsp::ClockDivider lightDivider;
    dsp::BooleanTrigger resetTrigger;
    /** Set by DSP on reset-button edge; consumed by the widget on the UI thread. */
    std::atomic<bool> resetRequested{false};

    BridgeModule() {
        config(PARAMS_LEN, INPUTS_LEN, OUTPUTS_LEN, LIGHTS_LEN);
        configButton(RESET_PARAM, "Reset pairing secret");
        lightDivider.setDivision(512);
        RackBridge::instance().bridgeModuleAdded();
    }

    ~BridgeModule() override { RackBridge::instance().bridgeModuleRemoved(); }

    void process(const ProcessArgs& args) override {
        // Atomic reads and light writes only; the heavy lifting lives elsewhere.
        if (resetTrigger.process(params[RESET_PARAM].getValue() > 0.5f))
            resetRequested.store(true);
        if (lightDivider.process()) {
            RackBridge& bridge = RackBridge::instance();
            bool running = bridge.running();
            bool sessions = running && bridge.server().activeSessions() > 0;
            bool lease = running && bridge.server().leaseHeldHint();
            bool unsavedWarning = running && !bridge.uiStateSavedHint();
            lights[CONNECTED_LIGHT].setBrightness(sessions ? 1.f : (running ? 0.15f : 0.f));
            lights[LEASE_LIGHT].setBrightness(lease ? 1.f : 0.f);
            lights[WARNING_LIGHT].setBrightness(unsavedWarning ? 1.f : 0.f);
        }
    }
};

struct BridgeStatusDisplay : widget::Widget {
    BridgeModule* module = NULL;

    void draw(const DrawArgs& args) override {
        nvgBeginPath(args.vg);
        nvgRoundedRect(args.vg, 0, 0, box.size.x, box.size.y, 3.f);
        nvgFillColor(args.vg, nvgRGB(0x10, 0x12, 0x14));
        nvgFill(args.vg);

        std::shared_ptr<window::Font> font =
            APP->window->loadFont(asset::system("res/fonts/ShareTechMono-Regular.ttf"));
        if (!font)
            return;
        nvgFontFaceId(args.vg, font->handle);
        nvgFontSize(args.vg, 9.f);
        nvgTextAlign(args.vg, NVG_ALIGN_LEFT | NVG_ALIGN_TOP);

        RackBridge& bridge = RackBridge::instance();
        std::string lines[6];
        if (!bridge.running()) {
            lines[0] = "BRIDGE OFFLINE";
        }
        else {
            UiStateCache state = bridge.uiState();
            LeaseHolder lease = bridge.server().leases().holder(steadyNowMs());
            lines[0] = "inst " + bridge.instanceId().substr(0, 8);
            lines[1] = "port " + std::to_string(bridge.server().port());
            int sessions = bridge.server().activeSessions();
            lines[2] = sessions > 0 ? ("clients " + std::to_string(sessions)) : "no clients";
            lines[3] = lease.held ? ("writer " + lease.clientName.substr(0, 12)) : "read-only";
            lines[4] = "op " + bridge.lastOp();
            if (!state.saved)
                lines[5] = "! unsaved patch";
        }
        float y = 3.f;
        for (const std::string& line : lines) {
            if (!line.empty()) {
                nvgFillColor(args.vg, line[0] == '!' ? nvgRGB(0xe0, 0x70, 0x30)
                                                     : nvgRGB(0x8f, 0xd8, 0x8f));
                nvgText(args.vg, 4.f, y, line.c_str(), NULL);
            }
            y += 10.f;
        }
    }
};

struct BridgeWidget : app::ModuleWidget {
    explicit BridgeWidget(BridgeModule* module) {
        setModule(module);
        setPanel(createPanel(asset::plugin(pluginInstance, "res/Bridge.svg")));

        addChild(createWidget<componentlibrary::ThemedScrew>(math::Vec(RACK_GRID_WIDTH, 0)));
        addChild(createWidget<componentlibrary::ThemedScrew>(
            math::Vec(box.size.x - 2 * RACK_GRID_WIDTH, RACK_GRID_HEIGHT - RACK_GRID_WIDTH)));

        auto* display = new BridgeStatusDisplay();
        display->module = module;
        display->box.pos = mm2px(math::Vec(3.5f, 15.f));
        display->box.size = mm2px(math::Vec(33.6f, 24.f));
        addChild(display);

        addChild(createLightCentered<componentlibrary::MediumLight<componentlibrary::GreenLight>>(
            mm2px(math::Vec(8.f, 48.f)), module, BridgeModule::CONNECTED_LIGHT));
        addChild(createLightCentered<componentlibrary::MediumLight<componentlibrary::YellowLight>>(
            mm2px(math::Vec(20.f, 48.f)), module, BridgeModule::LEASE_LIGHT));
        addChild(createLightCentered<componentlibrary::MediumLight<componentlibrary::RedLight>>(
            mm2px(math::Vec(32.f, 48.f)), module, BridgeModule::WARNING_LIGHT));

        addParam(createParamCentered<componentlibrary::VCVButton>(mm2px(math::Vec(20.f, 60.f)),
                                                                  module, BridgeModule::RESET_PARAM));
    }

    void step() override {
        ModuleWidget::step();
        // The persistent command pump attaches on the first Bridge widget step
        // and survives this module's removal (owned by the scene, not by us).
        CommandPumpWidget::ensureAttached();
        auto* bm = dynamic_cast<BridgeModule*>(module);
        if (bm && bm->resetRequested.exchange(false))
            RackBridge::instance().resetPairing();
    }

    void draw(const DrawArgs& args) override {
        ModuleWidget::draw(args);
        std::shared_ptr<window::Font> font =
            APP->window->loadFont(asset::system("res/fonts/ShareTechMono-Regular.ttf"));
        if (font) {
            nvgFontFaceId(args.vg, font->handle);
            nvgFillColor(args.vg, nvgRGB(0xe6, 0xe6, 0xe6));
            nvgFontSize(args.vg, 13.f);
            nvgTextAlign(args.vg, NVG_ALIGN_CENTER | NVG_ALIGN_MIDDLE);
            nvgText(args.vg, box.size.x / 2.f, mm2px(7.f), "MCP BRIDGE", NULL);
            nvgFontSize(args.vg, 8.f);
            nvgText(args.vg, mm2px(8.f), mm2px(52.5f), "LINK", NULL);
            nvgText(args.vg, mm2px(20.f), mm2px(52.5f), "WRITE", NULL);
            nvgText(args.vg, mm2px(32.f), mm2px(52.5f), "WARN", NULL);
            nvgText(args.vg, mm2px(20.f), mm2px(66.f), "RESET PAIRING", NULL);
        }
    }

    void appendContextMenu(ui::Menu* menu) override {
        menu->addChild(new ui::MenuSeparator);
        menu->addChild(rack::createMenuItem("Reset pairing secret", "", [] {
            RackBridge::instance().resetPairing();
        }));
    }
};

} // namespace rackmcp

rack::plugin::Model* modelBridge =
    rack::createModel<rackmcp::BridgeModule, rackmcp::BridgeWidget>("Bridge");
