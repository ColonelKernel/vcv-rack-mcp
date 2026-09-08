#pragma once
// Running a failed transaction's inverse actions, and counting how many of
// them actually ran.
//
// The rollback report promises `inversesExecuted` (spec section 6: "execute
// inverses in reverse order"), and the plugin filled it with
// `applier.applied.size()` -- the number of COMPLETED PLAN OPERATIONS. Those
// are not the same quantity and are not even close: `remove_module` pushes one
// CableRemove per attached cable plus a ModuleRemove, `disconnect_port` pushes
// one per matched cable and can push none, `add_module` pushes up to
// initialParams + 3, and the failing operation's own half-applied inverses --
// the ones an operator most needs to know ran -- were never counted at all,
// because each apply* records its `applied` entry only after it has finished.
//
// The sharper way to say it: `applied.size()` is provably equal to the loop
// index of the failing operation at the moment the report is built, so the
// report emitted the same integer twice under two different names,
// `failedOperationIndex` and `inversesExecuted`, and the second one carried no
// information whatsoever.
//
// Nor can the true number be read off the action list. `ComplexAction::undo`
// is a bare reverse iteration with no exception handling -- confirmed by
// disassembling the shipped libRack, not inferred from the header, which only
// declares it -- so a throwing inverse abandons the loop and every older
// inverse is skipped. `actions.size()` is therefore "inverses ATTEMPTED", and
// it over-reports in exactly the ROLLBACK_FAILED case the field exists to
// explain. (It is also unreadable by then: the ComplexAction is deleted before
// the report is packed.)
//
// So the count has to be observed while the inverses run, which means running
// them here rather than calling `ComplexAction::undo`. This loop is that same
// reverse iteration and nothing more: it stops at the first inverse that
// throws, exactly as Rack's does. Continuing past a throwing inverse was
// considered and rejected -- the one inverse type that can throw is also the
// one that mutates module ownership and identity, so continuing would run
// later inverses against a world whose invariants Rack had already abandoned,
// trading a bounded, reported residue for an unbounded one that no test on
// this project can exercise.
#include <cstddef>
#include <exception>
#include <string>
#include <vector>

namespace rackmcp {

/** What running a failed transaction's inverses actually did. */
struct InverseRun {
    /**
     * Inverse actions whose `undo()` returned normally. The one that threw is
     * not counted: it did not complete, and the older ones behind it never ran.
     */
    size_t executed;
    /** An inverse threw, so `executed` is short of the list length. */
    bool threw;
    /** Why, when `threw`; empty otherwise. */
    std::string detail;

    InverseRun() : executed(0), threw(false) {}
};

/**
 * Executes `actions` newest-first, stopping at the first one that throws.
 *
 * A template over anything with `undo()` rather than a function over
 * `rack::history::Action*`, so that this file -- and its test -- stay free of
 * Rack. `tests/cpp` cannot link Rack at all (`rack::contextGet()` is a NULL
 * thread-local outside a running Rack, and Engine/Scene/Window have private
 * constructors), so a fake that throws at a chosen index is the only way the
 * stop-and-count behaviour can be exercised on any platform.
 *
 * The three catch clauses mirror the plugin's own throw conventions: Rack and
 * third-party plugin code throw `std::exception` subclasses, this plugin
 * throws `std::string`, and `...` covers a plugin that throws neither.
 */
template <class Action>
InverseRun runInverses(const std::vector<Action*>& actions) {
    InverseRun run;
    for (size_t i = actions.size(); i-- > 0;) {
        try {
            actions[i]->undo();
        }
        catch (const std::string& e) {
            run.threw = true;
            run.detail = e;
            return run;
        }
        catch (const std::exception& e) {
            run.threw = true;
            run.detail = e.what();
            return run;
        }
        catch (...) {
            run.threw = true;
            run.detail = "an inverse action threw";
            return run;
        }
        run.executed++;
    }
    return run;
}

} // namespace rackmcp
