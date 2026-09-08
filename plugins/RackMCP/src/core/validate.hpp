#pragma once
// Transaction validation, as a pure function of a snapshot.
//
// `validateOne` decides every refusal a preview can make and every entry in the
// diff the client is shown before it confirms. It used to live in
// Transaction.cpp, interleaved with the Rack reads it needed -- which is the
// reason `plugins/RackMCP/src/rackside/` has no unit tests at all: the logic
// could not be reached without a running Rack, an OpenGL context, and a
// `rack::Context` whose constructors are PRIVATE.
//
// Nothing about the decisions needs Rack. They are a function of what the plan
// says and what the patch currently is, and `PlanWorld` is what the patch
// currently is. The Rack reads all happen once, in `snapshotWorld`, which stays
// in rackside; everything below runs in `tests/cpp` on three platforms.
//
// The snapshot is a contract change and not a pure refactor, disclosed rather
// than claimed away: the cable and panel reads used to happen fresh at each
// point of use, so a mutation from a third-party module's worker thread mid-
// validation produced a preview describing several instants at once. One
// snapshot describes one instant. Nothing on the UI thread can mutate during
// validation, so this is invisible in practice -- but it is a different
// promise, and the honest version is the better one.
#include <map>
#include <string>
#include <vector>

#include "core/layout.hpp"
#include "core/plan.hpp"

#if RACKMCP_HAVE_JANSSON
#include <jansson.h>

namespace rackmcp {

/** Why an operation was refused: the wire error code and its message. */
struct ValidationError {
    std::string code;
    std::string message;
};

/**
 * What the plan has been found to do so far.
 *
 * Accumulated across the operations in request order, because almost every
 * check is about the plan rather than about one operation: the last-Bridge
 * refusal counts what the plan leaves, a `connect` sees the input an earlier
 * `connect` already took, and a cable a `remove_module` swept up must not be
 * counted twice by a later `disconnect`.
 */
struct PreviewState {
    std::map<std::string, int64_t> aliases; // provisional: negative synthetic ids
    int64_t nextSyntheticId;
    std::vector<std::string> warnings;
    // diff accumulators
    std::vector<std::pair<std::string, std::pair<std::string, std::string> > > addedModules; // alias -> (plugin, model)
    std::vector<int64_t> removedModules, movedModules, modifiedModules;
    int addedCables;
    std::vector<int64_t> removedCables;
    std::vector<std::pair<int64_t, int> > replacedInputs, stackedInputs;
    // plan-local simulation: input ports an earlier operation already took
    std::vector<std::pair<int64_t, int> > claimedInputs;
    // plan-local layout: where earlier operations put modules, when that is
    // knowable exactly. `layoutUncertain` records that some operation makes the
    // final layout unpredictable at preview time (a module this plan creates,
    // or a nearest/squeeze move, where Rack chooses the resulting position), in
    // which case the collision check must not refuse anything.
    std::map<int64_t, layout::Box> plannedBoxes;
    bool layoutUncertain;
    // risk
    bool removesBridge, touchesAudio, missingModule;
    bool adapterUncertainty, possibleFeedback;

    PreviewState()
        : nextSyntheticId(-1000), addedCables(0), layoutUncertain(false), removesBridge(false),
          touchesAudio(false), missingModule(false), adapterUncertainty(false),
          possibleFeedback(false) {}

    /** Records a cable the plan removes; the diff and the risk read this. */
    void removeCable(int64_t cableId) {
        if (!cableRemoved(cableId))
            removedCables.push_back(cableId);
    }
    bool cableRemoved(int64_t cableId) const {
        for (size_t i = 0; i < removedCables.size(); i++)
            if (removedCables[i] == cableId)
                return true;
        return false;
    }
    bool moduleRemoved(int64_t moduleId) const {
        for (size_t i = 0; i < removedModules.size(); i++)
            if (removedModules[i] == moduleId)
                return true;
        return false;
    }
    bool inputClaimed(int64_t moduleId, int portId) const {
        for (size_t i = 0; i < claimedInputs.size(); i++)
            if (claimedInputs[i].first == moduleId && claimedInputs[i].second == portId)
                return true;
        return false;
    }
};

/**
 * Checks one operation against the snapshot and records what it would do.
 *
 * Returns false with `err` filled in on the first refusal; the caller stops
 * there and reports the index, so a plan is described only when all of it is
 * valid.
 */
bool validateOne(json_t* op, const PlanWorld& world, PreviewState& st, ValidationError& err);

/**
 * A live module the plan has not already removed -- what `liveModule` answered
 * when it called `Engine::getModule` and checked the removal list first.
 */
const WorldModule* liveModule(const PlanWorld& world, const PreviewState& st, int64_t moduleId);

/** Cables attached to a module that the plan has not already removed. */
std::vector<int64_t> cablesOnModule(const PlanWorld& world, const PreviewState& st,
                                    int64_t moduleId);
/** As above, narrowed to one port. `portType` is "input" or "output". */
std::vector<int64_t> cablesOnPort(const PlanWorld& world, const PreviewState& st, int64_t moduleId,
                                  const std::string& portType, int portId);

/**
 * Whether `box` is clear of every panel except the one at `selfIndex`, given
 * what earlier operations in this plan already did to the layout.
 */
bool positionFree(const PlanWorld& world, const PreviewState& st, size_t selfIndex,
                  const layout::Box& box);

} // namespace rackmcp
#endif // RACKMCP_HAVE_JANSSON
