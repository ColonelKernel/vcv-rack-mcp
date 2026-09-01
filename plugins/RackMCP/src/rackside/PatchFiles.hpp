#pragma once
// Patch file operations (spec section 8). UI thread only. Load and clear are
// owned here (the command pump), never a Bridge widget, so the executing
// object is never destroyed mid-call. Uses Rack's patch manager for .vcv;
// never rewrites archives directly. Increments the patch epoch on load/clear.
#include <string>

typedef struct json_t json_t;

namespace rackmcp {

struct PatchFileOutcome {
    json_t* payload = nullptr;
    std::string errorCode;
    std::string errorMessage;
};

/** Saves the current patch to `path` (does not change the current patch path). */
PatchFileOutcome patchSaveCopy(json_t* request);
/** Saves to `path` and adopts it as the current patch path. */
PatchFileOutcome patchSave(json_t* request);
/** Loads `path`, replacing the patch; increments the epoch. */
PatchFileOutcome patchLoad(json_t* request);
/** Clears the patch; increments the epoch. */
PatchFileOutcome patchClear(json_t* request);

/** True when the live patch contains at least one RackMCP-Bridge module. */
bool patchHasBridge();

} // namespace rackmcp
