// RackMCP-Chat: the conversation, inside Rack.
//
// A transcript of what the assistant has been doing, what you typed back, and
// what it said. The one thing this panel must be honest about is that nothing
// here can interrupt the assistant: the bridge is request/response with the
// server as the requester, and the server cannot push to its host either. So a
// note you type is *queued* until the assistant next calls a tool, and the
// panel marks it pending until that happens rather than pretending otherwise.
#include <rack.hpp>

#include "core/activitylog.hpp"
#include "core/frames.hpp"
#include "rackmcp_plugin.hpp"
#include "rackside/RackBridge.hpp"

namespace rackmcp {

using namespace rack;

struct ChatModule : engine::Module {
    enum ParamId { SCROLL_PARAM, PARAMS_LEN };
    enum InputId { INPUTS_LEN };
    enum OutputId { OUTPUTS_LEN };
    enum LightId { PENDING_LIGHT, LIGHTS_LEN };

    dsp::ClockDivider lightDivider;

    ChatModule() {
        config(PARAMS_LEN, INPUTS_LEN, OUTPUTS_LEN, LIGHTS_LEN);
        configParam(SCROLL_PARAM, 0.f, 1.f, 1.f, "Scroll");
        lightDivider.setDivision(512);
    }

    void process(const ProcessArgs& args) override {
        if (lightDivider.process()) {
            // Lit while at least one note has not been picked up yet.
            RackBridge& bridge = RackBridge::instance();
            const bool pending = bridge.running() && bridge.userNotesUndelivered() > 0;
            lights[PENDING_LIGHT].setBrightness(pending ? 1.f : 0.f);
        }
    }
};

/** One rendered line of the transcript, already wrapped and coloured. */
struct TranscriptLine {
    std::string text;
    NVGcolor color;
};

struct ChatTranscript : widget::Widget {
    ChatModule* module = NULL;

    std::vector<TranscriptLine> lines;
    int scrollOffset = 0;   // in whole lines, from the bottom
    bool following = true;  // stick to the newest unless the user scrolled up
    int refreshCountdown = 0;

    static const int LINE_HEIGHT = 10;

    void step() override {
        Widget::step();
        if (--refreshCountdown > 0)
            return;
        refreshCountdown = 15; // ~4 Hz; a transcript does not need 60
        rebuild();
    }

    /**
     * Re-wraps the whole transcript.
     *
     * Done on refresh rather than in draw() so wrapping is paid four times a
     * second instead of sixty, and so draw() stays a loop over strings.
     */
    void rebuild() {
        RackBridge& bridge = RackBridge::instance();
        std::vector<TranscriptLine> out;
        if (!bridge.running()) {
            out.push_back(TranscriptLine{"bridge offline", nvgRGB(0xe0, 0x70, 0x30)});
            lines.swap(out);
            return;
        }

        const NVGcolor youColor = nvgRGB(0xe6, 0xe6, 0xe6);
        const NVGcolor assistantColor = nvgRGB(0x8f, 0xc8, 0xe8);
        const NVGcolor okColor = nvgRGB(0x5e, 0x7a, 0x5e);
        const NVGcolor errColor = nvgRGB(0xe0, 0x70, 0x30);

        std::vector<ActivityEntry> activity = bridge.activity();
        std::vector<ChatEntry> chat = bridge.conversation();

        // Two streams merged on their display clocks. Neither shares a counter
        // with the other, so the clock is the only ordering both agree on.
        size_t a = 0, c = 0;
        while (a < activity.size() || c < chat.size()) {
            const bool takeChat =
                a >= activity.size() ||
                (c < chat.size() && chat[c].clock <= activity[a].clock);
            if (takeChat) {
                const ChatEntry& e = chat[c++];
                const std::string who = e.fromUser ? "you " : "mcp ";
                const std::string mark = e.fromUser ? (e.delivered ? " check" : " pending") : "";
                appendWrapped(out, e.clock + " " + who + e.text + mark,
                              e.fromUser ? youColor : assistantColor);
            }
            else {
                const ActivityEntry& e = activity[a++];
                std::string line = e.clock + "  " + e.method;
                if (e.ok())
                    line += "  ok " + std::to_string(e.elapsedMs) + "ms";
                else
                    line += "  " + e.errorCode;
                appendWrapped(out, line, e.ok() ? okColor : errColor);
            }
        }
        if (out.empty())
            out.push_back(TranscriptLine{"nothing yet", okColor});
        lines.swap(out);
    }

    /** Breaks on spaces at a fixed character budget for the panel width. */
    void appendWrapped(std::vector<TranscriptLine>& out, const std::string& text,
                       NVGcolor color) const {
        const size_t width = 40;
        size_t start = 0;
        while (start < text.size()) {
            size_t take = text.size() - start;
            if (take > width) {
                take = width;
                const size_t space = text.rfind(' ', start + width);
                if (space != std::string::npos && space > start + width / 2)
                    take = space - start;
            }
            out.push_back(TranscriptLine{text.substr(start, take), color});
            start += take;
            while (start < text.size() && text[start] == ' ')
                start++;
        }
    }

    int visibleLines() const { return (int) (box.size.y / (float) LINE_HEIGHT); }

    void onHoverScroll(const HoverScrollEvent& e) override {
        const int rows = visibleLines();
        const int maxOffset = std::max(0, (int) lines.size() - rows);
        if (e.scrollDelta.y > 0.f)
            scrollOffset = std::min(scrollOffset + 1, maxOffset);
        else if (e.scrollDelta.y < 0.f)
            scrollOffset = std::max(scrollOffset - 1, 0);
        following = scrollOffset == 0;
        // Consume, or the rack canvas scrolls out from under the panel.
        e.consume(this);
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
        nvgSave(args.vg);
        nvgScissor(args.vg, 0, 0, box.size.x, box.size.y);
        nvgFontFaceId(args.vg, font->handle);
        nvgFontSize(args.vg, 8.f);
        nvgTextAlign(args.vg, NVG_ALIGN_LEFT | NVG_ALIGN_TOP);

        const int rows = visibleLines();
        const int total = (int) lines.size();
        int first = total - rows - scrollOffset;
        if (first < 0)
            first = 0;
        float y = 2.f;
        for (int i = first; i < total && i < first + rows; i++) {
            nvgFillColor(args.vg, lines[(size_t) i].color);
            nvgText(args.vg, 3.f, y, lines[(size_t) i].text.c_str(), NULL);
            y += (float) LINE_HEIGHT;
        }
        if (!following) {
            nvgFillColor(args.vg, nvgRGB(0xe0, 0x9a, 0x40));
            nvgText(args.vg, box.size.x - 34.f, box.size.y - 10.f, "PAUSED", NULL);
        }
        nvgRestore(args.vg);
    }
};

/**
 * Single-line on purpose. With multiline off, Enter fires onAction instead of
 * inserting a newline, which is the behaviour a chat input wants — and it also
 * sidesteps blendish's 32-row limit on caret positioning inside an editable
 * field.
 */
struct ChatInputField : app::LedDisplayTextField {
    ChatTranscript* transcript = NULL;

    ChatInputField() {
        multiline = false;
        placeholder = "message the assistant";
        color = nvgRGB(0xe6, 0xe6, 0xe6);
        bgColor = nvgRGB(0x18, 0x1b, 0x1e);
    }

    void onAction(const ActionEvent& e) override {
        const std::string message = getText();
        if (!message.empty()) {
            RackBridge::instance().postUserNote(message);
            setText("");
            if (transcript) {
                transcript->refreshCountdown = 0; // show it immediately
                transcript->scrollOffset = 0;
                transcript->following = true;
            }
        }
        // Not forwarded: this is the end of the action, and the default would
        // walk focus to nextField.
        e.consume(this);
    }
};

struct ChatWidget : app::ModuleWidget {
    ChatTranscript* transcript = NULL;
    ChatInputField* input = NULL;

    explicit ChatWidget(ChatModule* module) {
        setModule(module);
        setPanel(createPanel(asset::plugin(pluginInstance, "res/Chat.svg")));

        addChild(createWidget<componentlibrary::ThemedScrew>(math::Vec(RACK_GRID_WIDTH, 0)));
        addChild(createWidget<componentlibrary::ThemedScrew>(
            math::Vec(box.size.x - 2 * RACK_GRID_WIDTH, RACK_GRID_HEIGHT - RACK_GRID_WIDTH)));

        transcript = new ChatTranscript();
        transcript->module = module;
        transcript->box.pos = mm2px(math::Vec(3.5f, 14.f));
        transcript->box.size = mm2px(math::Vec(74.3f, 91.f));
        addChild(transcript);

        input = new ChatInputField();
        input->transcript = transcript;
        input->box.pos = mm2px(math::Vec(3.5f, 107.f));
        input->box.size = mm2px(math::Vec(74.3f, 10.f));
        addChild(input);

        addChild(createLightCentered<componentlibrary::SmallLight<componentlibrary::YellowLight>>(
            mm2px(math::Vec(75.f, 7.f)), module, ChatModule::PENDING_LIGHT));
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
        nvgText(args.vg, box.size.x / 2.f, mm2px(7.f), "MCP CHAT", NULL);
        nvgFontSize(args.vg, 7.f);
        nvgFillColor(args.vg, nvgRGB(0x6a, 0x76, 0x7e));
        nvgTextAlign(args.vg, NVG_ALIGN_LEFT | NVG_ALIGN_MIDDLE);
        // Say the constraint on the panel, not only in the docs.
        nvgText(args.vg, mm2px(3.5f), mm2px(122.f),
                "enter queues a note; the assistant reads it on its next turn", NULL);
    }

    void appendContextMenu(ui::Menu* menu) override {
        menu->addChild(new ui::MenuSeparator);
        menu->addChild(rack::createMenuItem("Follow newest", "", [this] {
            if (transcript) {
                transcript->scrollOffset = 0;
                transcript->following = true;
            }
        }));
    }
};

} // namespace rackmcp

rack::plugin::Model* modelChat =
    rack::createModel<rackmcp::ChatModule, rackmcp::ChatWidget>("Chat");
