#pragma once
// The persistent command-pump widget. Attached to APP->scene (NOT scene->rack)
// after the first Bridge module is instantiated, so it survives patch load and
// clear, and it tolerates every Bridge module being removed mid-session.
// All Rack API work initiated by the bridge happens here, on the UI thread.
#include <rack.hpp>

namespace rackmcp {

struct CommandPumpWidget : rack::widget::TransparentWidget {
    CommandPumpWidget();
    ~CommandPumpWidget() override;
    void step() override;

    /** Idempotently attach the pump to the scene. UI thread only. */
    static void ensureAttached();

private:
    void refreshUiStateCache();
    int uiStateRefreshCountdown_ = 0;
};

} // namespace rackmcp
