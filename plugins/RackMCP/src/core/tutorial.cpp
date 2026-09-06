#include "core/tutorial.hpp"

namespace rackmcp {

namespace {

bool bridgeRunning(const TutorialState& s) { return s.bridgeRunning; }
bool bridgeModulePresent(const TutorialState& s) {
    return s.bridgeModules > 0 && s.pumpAttached;
}
bool hostConnected(const TutorialState& s) { return s.activeSessions > 0; }
bool patchRead(const TutorialState& s) { return !s.lastOp.empty(); }
bool leaseAcquired(const TutorialState& s) { return s.leaseHeld; }
bool transactionCommitted(const TutorialState& s) { return s.committedTransaction; }
bool modulesAdded(const TutorialState& s) { return s.userModules >= 3 && s.cables >= 2; }
bool audioPath(const TutorialState& s) { return s.audioDestinationFed; }
bool patchSaved(const TutorialState& s) { return s.patchSaved && s.patchHasPath; }

} // namespace

// Bodies are deliberately short and free of shell commands: the written guide
// owns prose, per-OS paths and anything you type into a terminal. This panel
// owns what is true on this rack right now.
const TutorialStep TUTORIAL_STEPS[] = {
    {"bridge_running", "Bridge service",
     "The plugin's local bridge is not listening. It starts with Rack; if this stays dark, "
     "something stopped it from opening a loopback port.",
     "troubleshooting.md", bridgeRunning},

    {"bridge_module", "Add a Bridge module",
     "Right-click the rack, add RackMCP-Bridge. Nothing outside Rack can see this instance until "
     "one is in the patch: the module is what attaches the command pump.",
     "installation.md", bridgeModulePresent},

    {"host_connected", "Connect your assistant",
     "Point an MCP host at the server and restart it. No client has completed the pairing "
     "handshake yet, so the rack is listening to nobody.",
     "configuration-examples.md", hostConnected},

    {"patch_read", "Let it look at the patch",
     "Connected, but nothing has been asked yet. Try: \"what's in my rack?\" — describe_patch and "
     "get_patch_snapshot only read, so this cannot change anything.",
     "tool-reference.md", patchRead},

    {"lease_acquired", "Take the writer lease",
     "Reading needs no permission; changing the patch needs the writer lease, and only one client "
     "holds it at a time. The server takes it when it first needs to write.",
     "pairing-and-multi-instance.md", leaseAcquired},

    {"transaction_committed", "Commit a change",
     "Ask for something concrete — \"add a VCO\". Every change is previewed with its risk flags "
     "first and committed second, and the whole transaction undoes as one step.",
     "tool-reference.md", transactionCommitted},

    {"modules_added", "Build a voice",
     "Three modules and a couple of cables make a patch worth hearing. Try: \"build a basic "
     "subtractive voice\" — that is a recipe, resolved against what you actually have installed.",
     "recipe-authoring.md", modulesAdded},

    {"audio_path", "Reach the audio output",
     "Modules are on the rack but nothing reaches an audio destination, so there is nothing to "
     "hear yet. Ask for the output to be connected, or patch it yourself.",
     "tool-reference.md", audioPath},

    {"patch_saved", "Save it",
     "Unsaved. Ask for the patch to be saved by name, or save it from Rack's File menu. Undo still "
     "works either way — this is about surviving a restart.",
     "backup-and-recovery.md", patchSaved},
};

const int TUTORIAL_STEP_COUNT = (int) (sizeof(TUTORIAL_STEPS) / sizeof(TUTORIAL_STEPS[0]));

int currentTutorialStep(const TutorialState& state) {
    for (int i = 0; i < TUTORIAL_STEP_COUNT; i++)
        if (!TUTORIAL_STEPS[i].satisfied(state))
            return i;
    return TUTORIAL_STEP_COUNT;
}

int satisfiedTutorialSteps(const TutorialState& state) {
    int n = 0;
    for (int i = 0; i < TUTORIAL_STEP_COUNT; i++)
        if (TUTORIAL_STEPS[i].satisfied(state))
            n++;
    return n;
}

std::string tutorialDiagnosis(const TutorialState& state, int step) {
    if (step < 0 || step >= TUTORIAL_STEP_COUNT)
        return std::string();

    // A host that keeps failing the handshake looks identical to no host at
    // all from the outside, and the two have completely different fixes. This
    // is the observation the written guide cannot make.
    if (state.authFailuresSinceOpen > 0 &&
        (step == 2 || step == 3))
        return "a client failed to authenticate " + std::to_string(state.authFailuresSinceOpen) +
               "x: its pairing secret is stale";

    if (step == 1 && state.bridgeModules > 0 && !state.pumpAttached)
        return "a Bridge module is present but the pump has not attached yet";

    if (step == 4 && !state.leaseHeld && !state.leaseHolder.empty())
        return "the lease is held by " + state.leaseHolder;

    if (step == 6 && state.userModules > 0)
        return "so far: " + std::to_string(state.userModules) + " modules, " +
               std::to_string(state.cables) + " cables";

    if (step == 8 && state.patchSaved && !state.patchHasPath)
        return "saved, but never given a filename";

    return std::string();
}

} // namespace rackmcp
