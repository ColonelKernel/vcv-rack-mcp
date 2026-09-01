#include "rackside/PatchFiles.hpp"

#include <rack.hpp>

#include <patch.hpp>
#include <plugin.hpp>

#include <jansson.h>

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
        // save() saves the patch and nothing else (does not change the path).
        APP->patch->save(path);
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
        APP->patch->save(path);
        APP->patch->path = path; // adopt as current
        if (APP->history)
            APP->history->setSaved();
    } catch (const std::exception& e) {
        out.errorCode = "INTERNAL";
        out.errorMessage = std::string("save failed: ") + e.what();
        return out;
    }
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
        out.errorCode = "INTERNAL";
        out.errorMessage = std::string("load failed: ") + e.what();
        return out;
    }
    bridge.bumpPatchEpoch();
    // Ensure a Bridge module so the loaded patch can reconnect after restart.
    if (!patchHasBridge()) {
        std::string w;
        if (insertBridgeModule(w) && !w.empty())
            warnings.push_back(w);
    }
    if (APP->history)
        APP->history->setSaved();
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
        out.errorCode = "INTERNAL";
        out.errorMessage = std::string("clear failed: ") + e.what();
        return out;
    }
    bridge.bumpPatchEpoch();
    if (!patchHasBridge()) {
        std::string w;
        if (insertBridgeModule(w) && !w.empty())
            warnings.push_back(w);
    }
    out.payload = buildResult(false, warnings);
    return out;
}

} // namespace rackmcp
