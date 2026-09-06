// RackMCP-Tutorial: a guided path from "the plugin is installed" to "I built a
// patch and heard it", where every step is checked against the live rack rather
// than ticked off by the reader.
//
// The panel deliberately does not repeat the written guide. Prose, shell
// commands and per-OS paths live in docs/; this module says what is true on
// this rack right now, which is the one thing a document cannot do.
#include <rack.hpp>
#include <patch.hpp>

#include "core/frames.hpp"
#include "core/tutorial.hpp"
#include "rackmcp_plugin.hpp"
#include "rackside/RackBridge.hpp"

namespace rackmcp {

using namespace rack;

struct TutorialModule : engine::Module {
    enum ParamId { PREV_PARAM, NEXT_PARAM, PARAMS_LEN };
    enum InputId { INPUTS_LEN };
    enum OutputId { OUTPUTS_LEN };
    enum LightId { LIGHTS_LEN };

    dsp::BooleanTrigger prevTrigger;
    dsp::BooleanTrigger nextTrigger;
    /** Set by DSP on a button edge; consumed by the widget on the UI thread. */
    std::atomic<int> browseRequest{0};

    /**
     * Highest step ever reached, latched so reopening a patch resumes rather
     * than restarting. Persisted by id, not index, so inserting a step does not
     * silently move everyone's progress.
     */
    std::string furthestStepId;

    TutorialModule() {
        config(PARAMS_LEN, INPUTS_LEN, OUTPUTS_LEN, LIGHTS_LEN);
        configButton(PREV_PARAM, "Previous step");
        configButton(NEXT_PARAM, "Next step");
    }

    void process(const ProcessArgs& args) override {
        // Edge detection only; everything else is UI-thread work.
        if (prevTrigger.process(params[PREV_PARAM].getValue() > 0.5f))
            browseRequest.store(-1);
        if (nextTrigger.process(params[NEXT_PARAM].getValue() > 0.5f))
            browseRequest.store(1);
    }

    json_t* dataToJson() override {
        json_t* root = json_object();
        json_object_set_new(root, "furthestStepId", json_string(furthestStepId.c_str()));
        return root;
    }

    void dataFromJson(json_t* root) override {
        if (!root)
            return;
        json_t* id = json_object_get(root, "furthestStepId");
        if (json_is_string(id))
            furthestStepId = json_string_value(id);
    }
};

/** Index of `id` in the step table, or -1 when it is not a step we know. */
static int stepIndexOf(const std::string& id) {
    for (int i = 0; i < TUTORIAL_STEP_COUNT; i++)
        if (id == TUTORIAL_STEPS[i].id)
            return i;
    return -1;
}

struct TutorialDisplay : widget::Widget {
    TutorialModule* module = NULL;

    /**
     * Cached state. draw() renders only these; it never enumerates the engine
     * and never takes a lock, so panel rendering stays off the critical path
     * whatever the rack is doing (docs/architecture/threading-model.md).
     */
    TutorialState state;
    int current = 0;
    int satisfied = 0;
    std::string diagnosis;
    /** Step being displayed, which the buttons can move away from `current`. */
    int browsing = -1;

    int refreshCountdown = 0;
    unsigned long authFailuresAtOpen = 0;
    bool authBaselineTaken = false;

    void step() override {
        Widget::step();
        if (module) {
            const int delta = module->browseRequest.exchange(0);
            if (delta != 0) {
                const int from = browsing < 0 ? current : browsing;
                browsing = math::clamp(from + delta, 0, TUTORIAL_STEP_COUNT - 1);
            }
        }
        // ~4 Hz. Rack calls step() once per frame; the tutorial's state moves
        // at human speed, so sampling every frame would be pure waste.
        if (--refreshCountdown > 0)
            return;
        refreshCountdown = 15;
        gather();
    }

    void gather() {
        TutorialState s;
        RackBridge& bridge = RackBridge::instance();
        s.bridgeRunning = bridge.running();
        s.bridgeModules = bridge.bridgeModuleCount();
        s.pumpAttached = bridge.pumpAttached();
        if (s.bridgeRunning) {
            s.port = bridge.server().port();
            s.activeSessions = bridge.server().activeSessions();
            const unsigned long failures =
                (unsigned long) bridge.server().counters().authFailures.load();
            if (!authBaselineTaken) {
                authFailuresAtOpen = failures;
                authBaselineTaken = true;
            }
            s.authFailuresSinceOpen = failures - authFailuresAtOpen;
            // Read the lease live rather than the DSP-safe hint: the hint is an
            // approximation that can claim a holder a moment after it expired.
            LeaseHolder lease = bridge.server().leases().holder(steadyNowMs());
            s.leaseHeld = lease.held;
            s.leaseHolder = lease.clientName;
        }
        const std::string lastOp = bridge.lastOp();
        // RackBridge reports "none" until something has run.
        s.lastOp = (lastOp == "none") ? std::string() : lastOp;
        std::string operationId, fingerprint;
        s.committedTransaction = bridge.lastMcpTransaction(operationId, fingerprint);

        // The rack itself. Read directly rather than through the pump's cache:
        // that cache is only refreshed while the bridge is running, so during
        // step 1 it would be stale rather than merely empty.
        gatherRack(s);

        state = s;
        current = currentTutorialStep(s);
        satisfied = satisfiedTutorialSteps(s);
        diagnosis = tutorialDiagnosis(s, browsing < 0 ? current : browsing);
        latchProgress();
    }

    void gatherRack(TutorialState& s) {
        if (!APP->engine)
            return;
        std::vector<int64_t> moduleIds = APP->engine->getModuleIds();
        for (int64_t id : moduleIds) {
            engine::Module* m = APP->engine->getModule(id);
            if (!m || !m->model || !m->model->plugin)
                continue;
            // RackMCP's own modules do not count as a patch the user built.
            if (m->model->plugin->slug != "RackMCP")
                s.userModules++;
        }
        std::vector<int64_t> cableIds = APP->engine->getCableIds();
        for (int64_t id : cableIds) {
            engine::Cable* cable = APP->engine->getCable(id);
            if (!cable || !cable->outputModule || !cable->inputModule)
                continue;
            s.cables++;
            engine::Module* dest = cable->inputModule;
            if (dest->model && dest->model->plugin && dest->model->plugin->slug == "Core" &&
                dest->model->slug.rfind("AudioInterface", 0) == 0)
                s.audioDestinationFed = true;
        }
        if (APP->patch)
            s.patchHasPath = !APP->patch->path.empty();
        if (APP->history)
            s.patchSaved = APP->history->isSaved();
    }

    void latchProgress() {
        if (!module)
            return;
        const int known = stepIndexOf(module->furthestStepId);
        const int reached = math::clamp(current, 0, TUTORIAL_STEP_COUNT - 1);
        if (reached > known)
            module->furthestStepId = TUTORIAL_STEPS[reached].id;
    }

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
        nvgTextAlign(args.vg, NVG_ALIGN_LEFT | NVG_ALIGN_TOP);

        // Everything below is clipped to the display, because nothing in this
        // plugin scissors today and an overlong line would draw across the panel.
        nvgSave(args.vg);
        nvgScissor(args.vg, 0, 0, box.size.x, box.size.y);

        const int shown = browsing < 0 ? math::clamp(current, 0, TUTORIAL_STEP_COUNT - 1) : browsing;
        const bool complete = current >= TUTORIAL_STEP_COUNT;

        drawRail(args, shown);
        const float textX = 16.f;
        const float textW = box.size.x - textX - 4.f;

        nvgFontSize(args.vg, 8.f);
        nvgFillColor(args.vg, nvgRGB(0x6a, 0x76, 0x7e));
        const std::string counter = complete && browsing < 0
                                        ? "ALL " + std::to_string(TUTORIAL_STEP_COUNT) + " DONE"
                                        : "STEP " + std::to_string(shown + 1) + " / " +
                                              std::to_string(TUTORIAL_STEP_COUNT);
        nvgText(args.vg, textX, 4.f, counter.c_str(), NULL);

        const TutorialStep& step = TUTORIAL_STEPS[shown];
        const bool done = step.satisfied(state);
        nvgFontSize(args.vg, 10.f);
        nvgFillColor(args.vg, done ? nvgRGB(0x8f, 0xd8, 0x8f) : nvgRGB(0xe6, 0xe6, 0xe6));
        nvgText(args.vg, textX, 16.f, step.title, NULL);

        // nvgTextBox wraps for free and has no row cap; the surrounding scissor
        // is what keeps a long body inside the panel.
        nvgFontSize(args.vg, 8.f);
        nvgTextLineHeight(args.vg, 1.3f);
        nvgFillColor(args.vg, nvgRGB(0xa8, 0xb2, 0xb8));
        nvgTextBox(args.vg, textX, 32.f, textW, step.body, NULL);

        float y = box.size.y - 46.f;
        if (!diagnosis.empty() && browsing < 0) {
            nvgFillColor(args.vg, nvgRGB(0xe0, 0x9a, 0x40));
            nvgTextBox(args.vg, textX, y, textW, diagnosis.c_str(), NULL);
        }
        y = box.size.y - 26.f;
        nvgFillColor(args.vg, nvgRGB(0x5c, 0x66, 0x6c));
        nvgText(args.vg, textX, y, ("see " + std::string(step.doc)).c_str(), NULL);

        // Live evidence, so the panel visibly reads the rack rather than
        // guessing: if these numbers are wrong, so is everything above.
        nvgText(args.vg, textX, y + 10.f, evidence().c_str(), NULL);

        nvgRestore(args.vg);
    }

    std::string evidence() const {
        if (!state.bridgeRunning)
            return "bridge offline";
        std::string line = "port " + std::to_string(state.port);
        line += state.activeSessions > 0 ? "  " + std::to_string(state.activeSessions) + "c" : "  0c";
        line += "  " + std::to_string(state.userModules) + "m";
        line += "  " + std::to_string(state.cables) + "w";
        return line;
    }

    void drawRail(const DrawArgs& args, int shown) const {
        const float x = 8.f;
        float y = 8.f;
        for (int i = 0; i < TUTORIAL_STEP_COUNT; i++) {
            const bool done = TUTORIAL_STEPS[i].satisfied(state);
            nvgBeginPath(args.vg);
            nvgCircle(args.vg, x, y, i == shown ? 3.2f : 2.2f);
            if (done) {
                nvgFillColor(args.vg, nvgRGB(0x8f, 0xd8, 0x8f));
                nvgFill(args.vg);
            }
            else {
                nvgStrokeColor(args.vg, i == shown ? nvgRGB(0xe6, 0xe6, 0xe6)
                                                   : nvgRGB(0x3a, 0x42, 0x48));
                nvgStrokeWidth(args.vg, 1.f);
                nvgStroke(args.vg);
            }
            y += 11.f;
        }
    }
};

struct TutorialWidget : app::ModuleWidget {
    TutorialDisplay* display = NULL;

    explicit TutorialWidget(TutorialModule* module) {
        setModule(module);
        setPanel(createPanel(asset::plugin(pluginInstance, "res/Tutorial.svg")));

        addChild(createWidget<componentlibrary::ThemedScrew>(math::Vec(RACK_GRID_WIDTH, 0)));
        addChild(createWidget<componentlibrary::ThemedScrew>(
            math::Vec(box.size.x - 2 * RACK_GRID_WIDTH, RACK_GRID_HEIGHT - RACK_GRID_WIDTH)));

        display = new TutorialDisplay();
        display->module = module;
        display->box.pos = mm2px(math::Vec(3.5f, 14.f));
        display->box.size = mm2px(math::Vec(53.9f, 96.f));
        addChild(display);

        addParam(createParamCentered<componentlibrary::VCVButton>(
            mm2px(math::Vec(19.f, 117.f)), module, TutorialModule::PREV_PARAM));
        addParam(createParamCentered<componentlibrary::VCVButton>(
            mm2px(math::Vec(42.f, 117.f)), module, TutorialModule::NEXT_PARAM));
    }

    void draw(const DrawArgs& args) override {
        ModuleWidget::draw(args);
        std::shared_ptr<window::Font> font =
            APP->window->loadFont(asset::system("res/fonts/ShareTechMono-Regular.ttf"));
        if (!font)
            return;
        nvgFontFaceId(args.vg, font->handle);
        nvgFillColor(args.vg, nvgRGB(0xe6, 0xe6, 0xe6));
        nvgFontSize(args.vg, 13.f);
        nvgTextAlign(args.vg, NVG_ALIGN_CENTER | NVG_ALIGN_MIDDLE);
        nvgText(args.vg, box.size.x / 2.f, mm2px(7.f), "MCP TUTORIAL", NULL);
        nvgFontSize(args.vg, 8.f);
        nvgText(args.vg, mm2px(19.f), mm2px(123.f), "PREV", NULL);
        nvgText(args.vg, mm2px(42.f), mm2px(123.f), "NEXT", NULL);
    }

    void appendContextMenu(ui::Menu* menu) override {
        menu->addChild(new ui::MenuSeparator);
        menu->addChild(rack::createMenuItem("Follow the live step", "", [this] {
            if (display)
                display->browsing = -1;
        }));
        menu->addChild(rack::createMenuItem("Reset saved progress", "", [this] {
            auto* tm = dynamic_cast<TutorialModule*>(module);
            if (tm)
                tm->furthestStepId.clear();
        }));
    }
};

} // namespace rackmcp

rack::plugin::Model* modelTutorial =
    rack::createModel<rackmcp::TutorialModule, rackmcp::TutorialWidget>("Tutorial");
