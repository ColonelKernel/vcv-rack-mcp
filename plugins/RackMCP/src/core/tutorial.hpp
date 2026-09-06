#pragma once
// The RackMCP-Tutorial module's step model, kept free of Rack so the
// progression logic can be tested against synthetic states. The module widget
// gathers a TutorialState from the live rack and calls in here; nothing in this
// file knows how any of it was measured.
#include <string>

namespace rackmcp {

/**
 * Everything the tutorial observes, sampled together on the UI thread.
 *
 * Sampled rather than queried per step so that one panel frame shows one
 * consistent picture: a step reporting "connected" while the step below it
 * reports "no clients" would be worse than either being briefly stale.
 */
struct TutorialState {
    bool bridgeRunning = false;
    int port = 0;
    int bridgeModules = 0;
    bool pumpAttached = false;
    int activeSessions = 0;
    /** Rise since the panel opened, not the absolute count. */
    unsigned long authFailuresSinceOpen = 0;
    /** Last bridge method executed, or empty when nothing has run yet. */
    std::string lastOp;
    bool leaseHeld = false;
    std::string leaseHolder;
    bool committedTransaction = false;
    /** Modules on the rack that are not RackMCP's own. */
    int userModules = 0;
    int cables = 0;
    /** A cable terminates on an audio-destination input. */
    bool audioDestinationFed = false;
    bool patchSaved = false;
    bool patchHasPath = false;
};

struct TutorialStep {
    /** Stable across releases: persisted in the module's JSON. */
    const char* id;
    const char* title;
    /** What is true now and what to do next, in Rack. Never a shell command. */
    const char* body;
    /** Where the full instructions live. A pointer, never a copy. */
    const char* doc;
    bool (*satisfied)(const TutorialState&);
};

extern const TutorialStep TUTORIAL_STEPS[];
extern const int TUTORIAL_STEP_COUNT;

/**
 * Index of the first unsatisfied step, or TUTORIAL_STEP_COUNT when every step
 * is satisfied.
 *
 * First-unsatisfied rather than count-satisfied: the steps are ordered by
 * dependency, so a later step passing while an earlier one fails means the
 * earlier one regressed (a lease timed out, a host disconnected) and that is
 * what the user needs to see.
 */
int currentTutorialStep(const TutorialState& state);

/** How many steps are satisfied, which need not be a prefix. */
int satisfiedTutorialSteps(const TutorialState& state);

/**
 * An extra line for the current step when the state says something the step
 * text cannot, or empty when there is nothing to add. This is the module's
 * reason to exist next to the written guide: it reports what just happened.
 */
std::string tutorialDiagnosis(const TutorialState& state, int step);

} // namespace rackmcp
