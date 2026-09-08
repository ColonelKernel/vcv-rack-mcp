#pragma once
// The exception barrier between a bridge handler and Rack's frame loop.
//
// `CommandPumpWidget::step()` is called by Rack, so anything a handler throws
// unwinds through `Widget::step` and out of the application -- Rack dies, and
// the caller waits out a deadline that reports "timeout" for something that was
// not one. The barrier converts a throw into an INTERNAL result instead.
//
// It lives here, as a template over the callable, for one reason: it is
// otherwise untestable. `tests/cpp` cannot link Rack, and the barrier's only
// caller is inside a Widget whose `step()` Rack drives, so the plan's standing
// note said proving it needed a fault-injection hook and a new wire method. A
// callable that throws needs neither.
//
// What this does and does not pin: the classification of all three throw
// conventions, the exact message each produces, and that the caller's result is
// left untouched when the call throws -- all on three platforms. It cannot pin
// that the pump actually routes through here; `tests/contract` does that
// separately by refusing a bare `executeCommand(` call in CommandPump.cpp.
#include <exception>
#include <string>

namespace rackmcp {

/** What a guarded call did, in the form its caller needs to answer with. */
struct GuardOutcome {
    /** The call threw; `out` was not assigned. */
    bool threw;
    /**
     * Caught by `...`, so there was no `what()` to quote. Kept separate from
     * `detail` because the two produce different log lines.
     */
    bool nonStandard;
    /** The reason, unadorned: what a log line should quote. */
    std::string detail;
    /** The reason as an error message, ready for the wire. */
    std::string message;

    GuardOutcome() : threw(false), nonStandard(false) {}
};

/**
 * Runs `call()` and assigns its result to `out`, turning any throw into a
 * described failure rather than letting it unwind into the caller's caller.
 *
 * The three catch clauses are the three throw conventions in play, in the order
 * the pump has always caught them: Rack and third-party plugin code throw
 * `std::exception` subclasses, this plugin's transaction applier throws
 * `std::string`, and a plugin may throw neither.
 *
 * `out` is assigned only on success, so a caller that ignores the outcome keeps
 * whatever it had rather than reading a half-built result.
 */
template <class Fn, class Result>
GuardOutcome guardedCall(Fn call, Result& out) {
    GuardOutcome outcome;
    try {
        out = call();
    }
    catch (const std::exception& e) {
        outcome.threw = true;
        outcome.detail = e.what();
        outcome.message = "handler threw: " + outcome.detail;
    }
    catch (const std::string& e) {
        outcome.threw = true;
        outcome.detail = e;
        outcome.message = "handler threw: " + outcome.detail;
    }
    catch (...) {
        outcome.threw = true;
        outcome.nonStandard = true;
        outcome.detail = "a non-standard exception";
        outcome.message = "handler threw a non-standard exception";
    }
    return outcome;
}

} // namespace rackmcp
