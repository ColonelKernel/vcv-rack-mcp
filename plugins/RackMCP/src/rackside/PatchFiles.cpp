#include "rackside/PatchFiles.hpp"

#include <rack.hpp>

#include <patch.hpp>
#include <plugin.hpp>

#include <jansson.h>

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>
#if defined(_WIN32)
#include <process.h>
#include <windows.h>
#else
#include <fcntl.h>
#include <unistd.h>
#endif

#include "core/frames.hpp"
#include "core/secret.hpp"
#include "rackside/RackBridge.hpp"
#include "rackside/Snapshot.hpp"

namespace rackmcp {

using namespace rack;

static const char* pstr(json_t* o, const char* key, const char* dflt = "") {
    json_t* v = o ? json_object_get(o, key) : NULL;
    return json_is_string(v) ? json_string_value(v) : dflt;
}

bool patchHasBridge() {
    for (int64_t id : APP->engine->getModuleIds()) {
        engine::Module* m = APP->engine->getModule(id);
        if (m && m->model && m->model->plugin && m->model->plugin->slug == "RackMCP" &&
            m->model->slug == "Bridge")
            return true;
    }
    return false;
}

/** Inserts a Bridge module so the patch can reconnect after restart. */
static bool insertBridgeModule(std::string& warning) {
    plugin::Model* model = plugin::getModel("RackMCP", "Bridge");
    if (!model) {
        warning = "RackMCP-Bridge model unavailable; patch will not reconnect after restart";
        return false;
    }
    engine::Module* module = model->createModule();
    if (!module)
        return false;
    APP->engine->addModule(module);
    app::ModuleWidget* mw = model->createModuleWidget(module);
    if (!mw) {
        APP->engine->removeModule(module);
        delete module;
        return false;
    }
    APP->scene->rack->addModule(mw);
    APP->scene->rack->setModulePosNearest(mw, math::Vec(0, 0));
    warning = "inserted a RackMCP-Bridge module so the patch can reconnect after restart";
    return true;
}

// --- Patch-replacement detection ------------------------------------------
// Rack's own File > New / Open / Revert (and patch drag-drop) replace the whole
// patch without passing through this file, and patch::Manager exposes no
// observer, so without a poll the epoch would keep validating references into a
// patch that no longer exists (spec section 5). The command pump polls the
// signals below. UI thread only, so plain statics suffice.

struct ReplacementWatermark {
    bool armed;
    std::string path;
    size_t historyCount;
    std::vector<int64_t> moduleIds; // sorted
    ReplacementWatermark() : armed(false), historyCount(0) {}
};
static ReplacementWatermark gWatermark;
static int gPollCountdown = 0;

static std::vector<int64_t> sortedModuleIds() {
    std::vector<int64_t> ids;
    if (APP && APP->engine)
        ids = APP->engine->getModuleIds();
    std::sort(ids.begin(), ids.end());
    return ids;
}

static size_t currentHistoryCount() {
    return (APP && APP->history) ? APP->history->actions.size() : 0;
}

/** Records the current patch identity as "expected", so the poll below does not
 *  report a replacement we performed ourselves. */
static void armReplacementWatermark() {
    gWatermark.armed = true;
    gWatermark.path = (APP && APP->patch) ? APP->patch->path : std::string();
    gWatermark.historyCount = currentHistoryCount();
    gWatermark.moduleIds = sortedModuleIds();
}

/** True when two sorted id lists share no element. */
static bool idsDisjoint(const std::vector<int64_t>& a, const std::vector<int64_t>& b) {
    size_t i = 0, j = 0;
    while (i < a.size() && j < b.size()) {
        if (a[i] == b[j])
            return false;
        if (a[i] < b[j])
            i++;
        else
            j++;
    }
    return true;
}

/** Bumps the epoch and tells clients to drop references into the old patch. */
static void bumpEpochAndNotify(RackBridge& bridge) {
    bridge.bumpPatchEpoch();
    bridge.server().broadcastEvent(buildEvent("patch_epoch_changed"));
}

void pollPatchReplacement() {
    if (!APP || !APP->patch)
        return;
    // ~2 Hz, the cadence the pump refreshes its UI-state cache at: the poll only
    // has to win the race against the client's next request, and reading the
    // module id set every frame buys nothing.
    if (--gPollCountdown > 0)
        return;
    gPollCountdown = 30;
    if (!gWatermark.armed) {
        armReplacementWatermark();
        return;
    }
    std::string path = APP->patch->path;
    size_t actions = currentHistoryCount();
    std::vector<int64_t> ids = sortedModuleIds();
    bool replaced;
    if (actions == 0 && gWatermark.historyCount > 0) {
        // Only patch::Manager::clear() empties the undo history, and every full
        // replacement (New, Open, Revert, drag-drop) goes through it.
        replaced = true;
    }
    else if (actions > gWatermark.historyCount) {
        // An action was pushed: editing, ours or the user's, never a
        // replacement. Re-arm so the module churn it caused is not read as one.
        replaced = false;
    }
    else {
        // Unedited since the watermark. A different path with a different module
        // set, or a wholly disjoint module set, means the patch was swapped.
        // Save As changes the path but keeps the modules, hence both halves.
        replaced = (path != gWatermark.path && ids != gWatermark.moduleIds) ||
                   (!gWatermark.moduleIds.empty() && idsDisjoint(ids, gWatermark.moduleIds));
    }
    gWatermark.path = path;
    gWatermark.historyCount = actions;
    gWatermark.moduleIds.swap(ids);
    if (replaced) {
        RackBridge& bridge = RackBridge::instance();
        bumpEpochAndNotify(bridge);
        INFO("RackMCP: patch replaced outside MCP; patch epoch is now %d", bridge.patchEpoch());
    }
}

// --- Atomic .vcv writes ----------------------------------------------------

/** Flushes a freshly written file to stable storage. Temp files only. */
static bool flushFileToDisk(const std::string& path) {
#if defined(_WIN32)
    std::wstring wpath = utf8ToWide(path);
    if (wpath.empty())
        return false;
    HANDLE h = CreateFileW(wpath.c_str(), GENERIC_WRITE, FILE_SHARE_READ, NULL, OPEN_EXISTING,
                           FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE)
        return false;
    BOOL ok = FlushFileBuffers(h);
    CloseHandle(h);
    return ok != FALSE;
#else
    // O_WRONLY and never O_TRUNC: some platforms refuse fsync on a read-only fd.
    int fd = open(path.c_str(), O_WRONLY);
    if (fd < 0)
        return false;
    bool ok = fsync(fd) == 0;
    close(fd);
    return ok;
#endif
}

/** Moves `src` onto `dest`, replacing it. Same filesystem only. */
static bool moveOverwrite(const std::string& src, const std::string& dest) {
#if defined(_WIN32)
    std::wstring wsrc = utf8ToWide(src), wdest = utf8ToWide(dest);
    if (wsrc.empty() || wdest.empty())
        return false;
    // rename() fails on Windows when the destination exists; MoveFileEx with
    // replace is the atomic equivalent on one volume (as in core/secret.cpp).
    return MoveFileExW(wsrc.c_str(), wdest.c_str(),
                       MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != FALSE;
#else
    return std::rename(src.c_str(), dest.c_str()) == 0;
#endif
}

/** Saves the live patch to `path` without ever truncating what is already
 *  there. Rack's Manager::save() archives straight into its destination, so an
 *  ENOSPC or I/O error part-way through would leave the user's only copy a
 *  half-written archive; write a sibling temp file, flush it, then move it over
 *  the target. Still Rack's patch manager doing the .vcv I/O. Throws like
 *  Manager::save() does. */
static void savePatchAtomic(const std::string& path) {
    // Sibling of the destination so the move stays on one filesystem, and
    // deliberately not a ".vcv" name so a leftover temp never shows up in
    // list_patch_files. Per-process, like core/secret.cpp: two Rack instances
    // sharing a patches dir must not clobber each other's in-flight write.
#if defined(_WIN32)
    std::string tmp = path + ".tmp-" + std::to_string((long long) _getpid());
#else
    std::string tmp = path + ".tmp-" + std::to_string((long long) getpid());
#endif
    try {
        APP->patch->save(tmp);
    } catch (...) {
        system::remove(tmp);
        throw;
    }
    if (!flushFileToDisk(tmp) || !moveOverwrite(tmp, path)) {
        system::remove(tmp);
        throw Exception("could not move the saved patch onto %s", path.c_str());
    }
}

static json_t* buildResult(bool saved, const std::vector<std::string>& warnings) {
    RackBridge& bridge = RackBridge::instance();
    UiStateCache state = bridge.uiState();
    json_t* payload = json_object();
    json_object_set_new(payload, "fingerprint", json_string(computePatchFingerprint().c_str()));
    json_object_set_new(payload, "patchEpoch", json_integer(bridge.patchEpoch()));
    std::string name;
    if (APP->patch && !APP->patch->path.empty())
        name = system::getStem(APP->patch->path);
    json_object_set_new(payload, "patchName", name.empty() ? json_null() : json_string(name.c_str()));
    json_object_set_new(payload, "saved", json_boolean(saved));
    // Where the CURRENT patch now lives. save with an empty request path means
    // "save where this patch already lives", which only this side can resolve
    // -- the server was reporting path "" for a file it had just written,
    // telling a caller the save succeeded but not where. Empty after a clear,
    // and unchanged by saveCopy, which deliberately does not adopt the copy's
    // path.
    json_object_set_new(payload, "path",
                        json_string(APP->patch ? APP->patch->path.c_str() : ""));
    json_object_set_new(payload, "bridgeModulePresent", json_boolean(patchHasBridge()));
    json_t* warnJ = json_array();
    for (auto& w : warnings)
        json_array_append_new(warnJ, json_string(w.c_str()));
    json_object_set_new(payload, "warnings", warnJ);
    json_object_set_new(payload, "replayed", json_false());
    (void) state;
    return payload;
}

PatchFileOutcome patchSaveCopy(json_t* request) {
    PatchFileOutcome out;
    std::string path = pstr(request, "path");
    if (path.empty()) {
        out.errorCode = "PATH_NOT_ALLOWED";
        out.errorMessage = "save copy requires a path";
        return out;
    }
    std::vector<std::string> warnings;
    if (!patchHasBridge())
        warnings.push_back("saved patch has no RackMCP-Bridge module; it will not reconnect after "
                           "restart");
    try {
        // Saves the patch and nothing else (does not change the path), and never
        // truncates an existing file at `path`.
        savePatchAtomic(path);
    } catch (const std::exception& e) {
        out.errorCode = "INTERNAL";
        out.errorMessage = std::string("save failed: ") + e.what();
        return out;
    }
    out.payload = buildResult(false, warnings);
    return out;
}

PatchFileOutcome patchSave(json_t* request) {
    PatchFileOutcome out;
    std::string path = pstr(request, "path");
    std::vector<std::string> warnings;
    if (!patchHasBridge())
        warnings.push_back("saved patch has no RackMCP-Bridge module; it will not reconnect after "
                           "restart");
    if (path.empty()) {
        if (APP->patch->path.empty()) {
            out.errorCode = "PATH_NOT_ALLOWED";
            out.errorMessage = "current patch has no path; provide one";
            return out;
        }
        path = APP->patch->path;
    }
    try {
        savePatchAtomic(path);
        APP->patch->path = path; // adopt as current
        if (APP->history)
            APP->history->setSaved();
    } catch (const std::exception& e) {
        out.errorCode = "INTERNAL";
        out.errorMessage = std::string("save failed: ") + e.what();
        return out;
    }
    // Adopting a new path is not a patch replacement; keep the poll from
    // reporting it as one.
    armReplacementWatermark();
    out.payload = buildResult(true, warnings);
    return out;
}

PatchFileOutcome patchLoad(json_t* request) {
    PatchFileOutcome out;
    std::string path = pstr(request, "path");
    bool setPath = true;
    json_t* sp = json_object_get(request, "setPath");
    if (json_is_boolean(sp))
        setPath = json_is_true(sp);
    if (path.empty()) {
        out.errorCode = "PATH_NOT_ALLOWED";
        out.errorMessage = "load requires a path";
        return out;
    }
    std::vector<std::string> warnings;
    RackBridge& bridge = RackBridge::instance();
    try {
        // Owned by the command pump: safe because the pump is a child of the
        // scene, not the rack, so rebuilding the rack does not destroy it.
        APP->patch->load(path);
        if (setPath)
            APP->patch->path = path;
    } catch (const std::exception& e) {
        // Manager::load() clears the patch (and the autosave dir) before it
        // touches the archive, so the throw leaves an empty rack behind, not the
        // previous patch. Report that instead of implying nothing happened:
        // bump the epoch so references into the replaced patch are rejected,
        // and restore a Bridge module as after any other replacement.
        bumpEpochAndNotify(bridge);
        std::string w;
        if (!patchHasBridge())
            insertBridgeModule(w);
        armReplacementWatermark();
        out.errorCode = "INTERNAL";
        out.errorMessage = std::string("load failed: ") + e.what() +
                           "; Rack cleared the patch before reading the file, so the rack is now "
                           "empty at patch epoch " + std::to_string(bridge.patchEpoch()) +
                           " -- restore the recovery checkpoint to get the previous patch back";
        return out;
    }
    bumpEpochAndNotify(bridge);
    // Ensure a Bridge module so the loaded patch can reconnect after restart.
    if (!patchHasBridge()) {
        std::string w;
        if (insertBridgeModule(w) && !w.empty())
            warnings.push_back(w);
    }
    if (APP->history)
        APP->history->setSaved();
    armReplacementWatermark();
    out.payload = buildResult(true, warnings);
    return out;
}

PatchFileOutcome patchClear(json_t* request) {
    PatchFileOutcome out;
    (void) request;
    std::vector<std::string> warnings;
    RackBridge& bridge = RackBridge::instance();
    try {
        APP->patch->clear();
        APP->patch->path = "";
    } catch (const std::exception& e) {
        // Manager::clear() tears the patch down before it can fail, so a throw
        // still leaves the rack changed. Bump the epoch on the way out for the
        // same reason patchLoad does: every client reference into the old patch
        // must stop validating, whether or not the operation succeeded.
        bumpEpochAndNotify(bridge);
        armReplacementWatermark();
        out.errorCode = "INTERNAL";
        out.errorMessage = std::string("clear failed: ") + e.what() +
                           " (the patch may be partly cleared; epoch is now " +
                           std::to_string(bridge.patchEpoch()) + ")";
        return out;
    }
    bumpEpochAndNotify(bridge);
    if (!patchHasBridge()) {
        std::string w;
        if (insertBridgeModule(w) && !w.empty())
            warnings.push_back(w);
    }
    armReplacementWatermark();
    out.payload = buildResult(false, warnings);
    return out;
}

} // namespace rackmcp
