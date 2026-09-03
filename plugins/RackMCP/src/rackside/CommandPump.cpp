#include "rackside/CommandPump.hpp"

#include <patch.hpp>

#include <jansson.h>

#include "core/frames.hpp"
#include "gen/rackmcp_protocol_gen.hpp"
#include "rackside/Handlers.hpp"
#include "rackside/PatchFiles.hpp"
#include "rackside/RackBridge.hpp"

namespace rackmcp {

static CommandPumpWidget* gPump = NULL;

CommandPumpWidget::CommandPumpWidget() {
    box.size = rack::math::Vec(0, 0);
}

CommandPumpWidget::~CommandPumpWidget() {
    gPump = NULL;
    RackBridge::instance().setPumpAttached(false);
}

void CommandPumpWidget::ensureAttached() {
    if (gPump)
        return;
    if (!APP || !APP->scene)
        return;
    gPump = new CommandPumpWidget();
    APP->scene->addChild(gPump);
    RackBridge::instance().setPumpAttached(true);
    INFO("RackMCP: command pump attached to scene");
}

void CommandPumpWidget::step() {
    TransparentWidget::step();
    RackBridge& bridge = RackBridge::instance();
    if (!bridge.running())
        return;

    // Drain commands within the per-frame budget.
    int drained = 0;
    int64_t start = steadyNowMs();
    BridgeCommand cmd;
    while (drained < gen::LIMIT_PUMP_COMMANDS_PER_FRAME &&
           steadyNowMs() - start <= gen::LIMIT_PUMP_FRAME_BUDGET_MS &&
           bridge.commandQueue().tryPop(cmd)) {
        std::string frame;
        int64_t now = steadyNowMs();
        if (now > cmd.deadlineAtMs) {
            bridge.server().counters().requestsInline++; // counted as handled
            frame = buildResError(cmd.requestId, "TIMEOUT",
                                  "deadline expired before execution began", false, false);
        }
        else if (!bridge.server().commandLeaseStillValid(cmd)) {
            // The lease was checked at enqueue time, but the command has been
            // sitting in the queue since: the holder may have released it, let
            // it expire, or lost it to another connection. Mutating work must
            // never run on a lease the caller no longer holds.
            bridge.server().counters().requestsInline++;
            frame = buildResError(cmd.requestId, "WRITER_LEASE_REQUIRED",
                                  "writer lease no longer held by this connection", true, false);
        }
        else {
            frame = executeCommand(cmd);
            bridge.setLastOp(cmd.method);
        }
        if (cmd.payload) {
            json_decref(cmd.payload);
            cmd.payload = NULL;
        }
        bridge.server().sendFrame(cmd.connectionId, frame);
        drained++;
    }
    if (drained > 0) {
        int64_t drainMs = steadyNowMs() - start;
        bridge.pumpLastDrainMs.store(drainMs);
        int64_t prevMax = bridge.pumpMaxDrainMs.load();
        while (drainMs > prevMax && !bridge.pumpMaxDrainMs.compare_exchange_weak(prevMax, drainMs)) {
        }
    }

    // Notice a patch the user replaced through Rack's own UI (File > New/Open/
    // Revert, drag-drop) so client references into the old patch stop
    // validating. Self-throttling, so calling it every frame is correct.
    pollPatchReplacement();

    // Refresh the UI-state cache about twice a second.
    if (--uiStateRefreshCountdown_ <= 0) {
        uiStateRefreshCountdown_ = 30;
        refreshUiStateCache();
    }
}

void CommandPumpWidget::refreshUiStateCache() {
    RackBridge& bridge = RackBridge::instance();
    UiStateCache state;
    state.commandPumpPresent = true;
    state.bridgeModulePresent = bridge.bridgeModuleCount() > 0;
    if (APP->patch) {
        std::string path = APP->patch->path;
        state.patchName = path.empty() ? "" : rack::system::getStem(path);
    }
    if (APP->history)
        state.saved = APP->history->isSaved();
    bridge.publishUiState(state);
}

} // namespace rackmcp
