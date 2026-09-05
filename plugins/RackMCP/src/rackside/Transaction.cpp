#include "rackside/Transaction.hpp"

#include <rack.hpp>

#include <patch.hpp>
#include <plugin.hpp>

#include <cmath>
#include <cstring>
#include <exception>
#include <functional>
#include <map>
#include <string>
#include <vector>

#include <jansson.h>

#include "core/canonical.hpp"
#include "core/frames.hpp"
#include "rackside/RackBridge.hpp"
#include "rackside/Snapshot.hpp"

namespace rackmcp {

using namespace rack;

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

static const char* jstr(json_t* o, const char* key, const char* dflt = "") {
    json_t* v = o ? json_object_get(o, key) : NULL;
    return json_is_string(v) ? json_string_value(v) : dflt;
}
static bool jbool(json_t* o, const char* key, bool dflt) {
    json_t* v = o ? json_object_get(o, key) : NULL;
    return json_is_boolean(v) ? json_is_true(v) : dflt;
}
static bool jhasKey(json_t* o, const char* key) {
    return o && json_object_get(o, key) != NULL;
}

/** Resolves a module reference: {"moduleId":"N"} or {"alias":"name"}. */
struct RefResult {
    bool ok = false;
    int64_t moduleId = -1;
    std::string alias; // set when the ref is an unresolved alias
    bool isAlias = false;
};

static RefResult resolveRef(json_t* ref, const std::map<std::string, int64_t>& aliases) {
    RefResult r;
    if (!json_is_object(ref))
        return r;
    json_t* mid = json_object_get(ref, "moduleId");
    if (json_is_string(mid)) {
        char* endp = NULL;
        long long id = strtoll(json_string_value(mid), &endp, 10);
        if (endp && *endp == '\0' && id >= 0) {
            r.ok = true;
            r.moduleId = (int64_t) id;
        }
        return r;
    }
    json_t* al = json_object_get(ref, "alias");
    if (json_is_string(al)) {
        r.isAlias = true;
        r.alias = json_string_value(al);
        auto it = aliases.find(r.alias);
        if (it != aliases.end()) {
            r.ok = true;
            r.moduleId = it->second;
        }
        return r;
    }
    return r;
}

/**
 * computePatchFingerprint() serializes every module, so a third-party
 * dataToJson() can throw. Nothing above this file catches, so contain it here.
 */
static bool safeFingerprint(std::string& fingerprint) {
    try {
        fingerprint = computePatchFingerprint();
        return true;
    }
    catch (...) {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Grid <-> pixel conversion
// ---------------------------------------------------------------------------

static math::Vec gridToPixel(int gx, int gy) {
    return math::Vec((gx + 2000) * RACK_GRID_WIDTH, (gy + 100) * RACK_GRID_HEIGHT);
}

/** Rightmost occupied pixel x, for automatic placement. */
static float rightmostEdge() {
    float maxX = gridToPixel(0, 0).x;
    for (int64_t id : APP->engine->getModuleIds()) {
        app::ModuleWidget* mw = APP->scene->rack->getModule(id);
        if (mw)
            maxX = std::max(maxX, mw->box.pos.x + mw->box.size.x);
    }
    return maxX;
}

// ---------------------------------------------------------------------------
// Preview: validation without mutation
// ---------------------------------------------------------------------------

namespace {

struct ValidationError {
    std::string code;
    std::string message;
};

/** Tracks provisional alias declarations while validating (no mutation). */
struct PreviewState {
    std::map<std::string, int64_t> aliases; // provisional: negative synthetic ids
    int64_t nextSyntheticId = -1000;
    std::vector<std::string> warnings;
    // diff accumulators
    std::vector<std::pair<std::string, std::pair<std::string, std::string>>> addedModules; // alias -> (plugin, model)
    std::vector<int64_t> removedModules, movedModules, modifiedModules;
    int addedCables = 0;
    std::vector<int64_t> removedCables;
    std::vector<std::pair<int64_t, int>> replacedInputs, stackedInputs;
    // plan-local simulation: input ports an earlier operation already took
    std::vector<std::pair<int64_t, int>> claimedInputs;
    // plan-local layout: where earlier operations put modules, when that is
    // knowable exactly. `layoutUncertain` records that some operation makes the
    // final layout unpredictable at preview time (a module this plan creates,
    // or a nearest/squeeze move, where Rack chooses the resulting position), in
    // which case the collision check must not refuse anything.
    std::map<int64_t, math::Rect> plannedBoxes;
    bool layoutUncertain = false;
    // risk
    bool removesBridge = false, touchesAudio = false, missingModule = false;
    bool adapterUncertainty = false, possibleFeedback = false;

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

int bridgeModuleCountLive() {
    int n = 0;
    for (int64_t id : APP->engine->getModuleIds()) {
        engine::Module* m = APP->engine->getModule(id);
        if (m && m->model && m->model->plugin && m->model->plugin->slug == "RackMCP" &&
            m->model->slug == "Bridge")
            n++;
    }
    return n;
}

bool isAudioModule(engine::Module* m) {
    return m && m->model && m->model->plugin && m->model->plugin->slug == "Core" &&
           m->model->slug.rfind("Audio", 0) == 0;
}

/** A live module, treating one an earlier plan operation removes as gone. */
engine::Module* liveModule(const PreviewState& st, int64_t moduleId) {
    if (st.moduleRemoved(moduleId))
        return NULL;
    return APP->engine->getModule(moduleId);
}

/** Live cables attached to a module that the plan has not already removed. */
std::vector<int64_t> cablesOnModule(const PreviewState& st, int64_t moduleId) {
    std::vector<int64_t> hits;
    for (int64_t cid : APP->engine->getCableIds()) {
        engine::Cable* c = APP->engine->getCable(cid);
        if (!c || st.cableRemoved(cid))
            continue;
        if ((c->inputModule && c->inputModule->id == moduleId) ||
            (c->outputModule && c->outputModule->id == moduleId))
            hits.push_back(cid);
    }
    return hits;
}

/** Mirrors Applier::applyDisconnectPort's match set, minus already-removed cables. */
std::vector<int64_t> cablesOnPort(const PreviewState& st, int64_t moduleId,
                                  const std::string& portType, int portId) {
    std::vector<int64_t> hits;
    for (int64_t cid : APP->engine->getCableIds()) {
        engine::Cable* c = APP->engine->getCable(cid);
        if (!c || st.cableRemoved(cid))
            continue;
        bool hit = (portType == "input" && c->inputModule && c->inputModule->id == moduleId &&
                    c->inputId == portId) ||
                   (portType == "output" && c->outputModule && c->outputModule->id == moduleId &&
                    c->outputId == portId);
        if (hit)
            hits.push_back(cid);
    }
    return hits;
}

/** Whether `box` is free of every module the plan leaves in place (except `self`). */
bool positionFree(const PreviewState& st, app::ModuleWidget* self, math::Rect box) {
    std::vector<app::ModuleWidget*> mws = APP->scene->rack->getModules();
    for (size_t i = 0; i < mws.size(); i++) {
        app::ModuleWidget* other = mws[i];
        if (!other || other == self)
            continue;
        if (other->module && st.moduleRemoved(other->module->id))
            continue;
        // Where an earlier operation in this plan already moved `other`, judge
        // against that position rather than the one it still occupies live.
        math::Rect otherBox = other->box;
        if (other->module) {
            std::map<int64_t, math::Rect>::const_iterator it =
                st.plannedBoxes.find(other->module->id);
            if (it != st.plannedBoxes.end())
                otherBox = it->second;
        }
        if (box.isIntersecting(otherBox))
            return false;
    }
    return true;
}

bool validateOne(json_t* op, PreviewState& st, ValidationError& err) {
    std::string type = jstr(op, "op");

    if (type == "add_module") {
        std::string pslug = jstr(op, "pluginSlug");
        std::string mslug = jstr(op, "modelSlug");
        std::string alias = jstr(op, "alias");
        if (!plugin::getModel(pslug, mslug)) {
            err = {"MODEL_NOT_INSTALLED", "model " + pslug + "/" + mslug + " is not installed"};
            st.missingModule = true;
            return false;
        }
        if (alias.empty() || st.aliases.count(alias)) {
            err = {"BAD_REQUEST", "duplicate or empty transaction alias '" + alias + "'"};
            return false;
        }
        st.aliases[alias] = st.nextSyntheticId--;
        st.addedModules.push_back({alias, {pslug, mslug}});
        // The new module's panel width, and so where it lands, is not known
        // until it is created at commit time.
        st.layoutUncertain = true;
        if (pslug == "Core" && mslug.rfind("Audio", 0) == 0)
            st.touchesAudio = true;
        if (pslug != "Core" && pslug != "Fundamental" && pslug != "RackMCP")
            st.adapterUncertainty = true;
        return true;
    }

    if (type == "remove_module") {
        RefResult r = resolveRef(json_object_get(op, "module"), st.aliases);
        if (!r.ok) {
            err = {"MODULE_NOT_FOUND", "remove_module: unresolved module reference"};
            return false;
        }
        if (r.moduleId >= 0) {
            engine::Module* m = liveModule(st, r.moduleId);
            if (!m) {
                err = {"MODULE_NOT_FOUND", "no module with id " + std::to_string(r.moduleId)};
                return false;
            }
            bool isBridge = m->model && m->model->plugin && m->model->plugin->slug == "RackMCP" &&
                            m->model->slug == "Bridge";
            if (isBridge && !jbool(op, "allowLastBridge", false) && bridgeModuleCountLive() <= 1) {
                err = {"UNSUPPORTED_OPERATION",
                       "refusing to remove the last RackMCP-Bridge module (set allowLastBridge)"};
                st.removesBridge = true;
                return false;
            }
            if (isBridge)
                st.removesBridge = true;
            if (isAudioModule(m))
                st.touchesAudio = true;
            // The cable policy decides between refusing and taking the cables
            // with the module; either way the diff must list them.
            std::string cablePolicy = jstr(op, "cablePolicy", "remove_attached");
            std::vector<int64_t> attached = cablesOnModule(st, r.moduleId);
            if (!attached.empty() && cablePolicy == "fail_if_connected") {
                err = {"VALIDATION_FAILED",
                       "remove_module: module " + std::to_string(r.moduleId) +
                           " has attached cables (policy fail_if_connected)"};
                return false;
            }
            for (size_t i = 0; i < attached.size(); i++)
                st.removeCable(attached[i]);
            st.removedModules.push_back(r.moduleId);
        }
        return true;
    }

    if (type == "set_parameter" || type == "set_bypass" || type == "reset_module" ||
        type == "randomize_module") {
        RefResult r = resolveRef(json_object_get(op, "module"), st.aliases);
        if (!r.ok) {
            err = {"MODULE_NOT_FOUND", type + ": unresolved module reference"};
            return false;
        }
        if (r.moduleId >= 0) {
            engine::Module* m = liveModule(st, r.moduleId);
            if (!m) {
                err = {"MODULE_NOT_FOUND", "no module with id " + std::to_string(r.moduleId)};
                return false;
            }
            if (type == "set_parameter") {
                int paramId = (int) json_integer_value(json_object_get(op, "paramId"));
                if (paramId < 0 || paramId >= (int) m->params.size()) {
                    err = {"PARAMETER_NOT_FOUND",
                           "param " + std::to_string(paramId) + " out of range"};
                    return false;
                }
            }
            st.modifiedModules.push_back(r.moduleId);
        }
        else {
            st.modifiedModules.push_back(r.moduleId); // synthetic; applied post-add
        }
        return true;
    }

    if (type == "move_module") {
        RefResult r = resolveRef(json_object_get(op, "module"), st.aliases);
        if (!r.ok) {
            err = {"MODULE_NOT_FOUND", "move_module: unresolved module reference"};
            return false;
        }
        // Schema field is `collision` (CollisionPolicy), not `collisionPolicy`.
        std::string policy = jstr(op, "collision", "nearest");
        if (r.moduleId >= 0) {
            if (!liveModule(st, r.moduleId)) {
                err = {"MODULE_NOT_FOUND", "no module with id " + std::to_string(r.moduleId)};
                return false;
            }
            app::ModuleWidget* mw = APP->scene->rack->getModule(r.moduleId);
            if (mw) {
                json_t* p = json_object_get(op, "position");
                math::Rect target(gridToPixel((int) json_integer_value(json_object_get(p, "x")),
                                              (int) json_integer_value(json_object_get(p, "y"))),
                                  mw->box.size);
                // Only refuse when the resulting layout is known exactly:
                // apply-time requestModulePos stays the authority, and a
                // preview must never reject a plan that would have committed.
                if (policy == "fail" && !st.layoutUncertain && !positionFree(st, mw, target)) {
                    err = {"VALIDATION_FAILED",
                           "move_module: target position is occupied (collision fail)"};
                    return false;
                }
                if (policy == "fail" || policy == "force")
                    st.plannedBoxes[r.moduleId] = target; // lands exactly here
                else
                    st.layoutUncertain = true; // nearest/squeeze: Rack decides
            }
        }
        st.movedModules.push_back(r.moduleId);
        return true;
    }

    if (type == "connect") {
        json_t* outRef = json_object_get(op, "output");
        json_t* inRef = json_object_get(op, "input");
        RefResult out = resolveRef(json_object_get(outRef, "module"), st.aliases);
        RefResult in = resolveRef(json_object_get(inRef, "module"), st.aliases);
        if (!out.ok || !in.ok) {
            err = {"MODULE_NOT_FOUND", "connect: unresolved output/input reference"};
            return false;
        }
        int outId = (int) json_integer_value(json_object_get(outRef, "portId"));
        int inId = (int) json_integer_value(json_object_get(inRef, "portId"));
        std::string policy = jstr(op, "inputPolicy", "fail_if_connected");
        // Bounds check against live modules (synthetic modules validated at apply).
        if (out.moduleId >= 0) {
            engine::Module* m = liveModule(st, out.moduleId);
            if (!m || outId < 0 || outId >= (int) m->outputs.size()) {
                err = {"PORT_NOT_FOUND", "connect: output port out of range"};
                return false;
            }
            if (isAudioModule(m))
                st.touchesAudio = true;
        }
        // Input already connected -- by a live cable the plan keeps, or by an
        // earlier connect in this same plan.
        bool connected = st.inputClaimed(in.moduleId, inId);
        std::vector<int64_t> existing;
        if (in.moduleId >= 0) {
            engine::Module* m = liveModule(st, in.moduleId);
            if (!m || inId < 0 || inId >= (int) m->inputs.size()) {
                err = {"PORT_NOT_FOUND", "connect: input port out of range"};
                return false;
            }
            if (isAudioModule(m))
                st.touchesAudio = true;
            existing = cablesOnPort(st, in.moduleId, "input", inId);
            if (!existing.empty())
                connected = true;
        }
        if (connected) {
            if (policy == "fail_if_connected") {
                err = {"VALIDATION_FAILED",
                       "connect: input already connected (policy fail_if_connected)"};
                return false;
            }
            if (policy == "stack") {
                err = {"UNSUPPORTED_OPERATION",
                       "VCV Rack inputs accept a single cable; use replace_all or a different "
                       "input"};
                return false;
            }
            // replace_all: the existing cables go away.
            if (in.moduleId >= 0 && !existing.empty())
                st.replacedInputs.push_back({in.moduleId, inId});
            for (size_t i = 0; i < existing.size(); i++)
                st.removeCable(existing[i]);
        }
        st.claimedInputs.push_back({in.moduleId, inId});
        st.addedCables++;
        return true;
    }

    if (type == "disconnect") {
        json_t* cref = json_object_get(op, "cable");
        const char* cidStr = jstr(cref, "cableId", "");
        char* endp = NULL;
        long long cid = strtoll(cidStr, &endp, 10);
        if (!endp || *endp != '\0' || !APP->engine->getCable(cid)) {
            err = {"CABLE_NOT_FOUND", "disconnect: no cable " + std::string(cidStr)};
            return false;
        }
        if (st.cableRemoved(cid)) {
            err = {"CABLE_NOT_FOUND",
                   "disconnect: cable " + std::string(cidStr) + " is already removed by an earlier "
                   "operation in this plan"};
            return false;
        }
        st.removeCable(cid);
        return true;
    }

    if (type == "disconnect_port") {
        json_t* portRef = json_object_get(op, "port");
        RefResult r = resolveRef(json_object_get(portRef, "module"), st.aliases);
        if (!r.ok && r.moduleId < 0) {
            err = {"MODULE_NOT_FOUND", "disconnect_port: unresolved module"};
            return false;
        }
        if (r.moduleId >= 0) {
            engine::Module* m = liveModule(st, r.moduleId);
            if (!m) {
                err = {"MODULE_NOT_FOUND", "no module with id " + std::to_string(r.moduleId)};
                return false;
            }
            if (isAudioModule(m))
                st.touchesAudio = true;
            // Enumerate exactly what apply will remove, so the diff discloses
            // the cables and the destructive classification picks them up.
            int portId = (int) json_integer_value(json_object_get(portRef, "portId"));
            std::string ptype = jstr(portRef, "portType", "input");
            std::string policy = jstr(op, "policy", "all");
            std::vector<int64_t> matches = cablesOnPort(st, r.moduleId, ptype, portId);
            if (policy == "top" && !matches.empty())
                matches = std::vector<int64_t>(1, matches.back());
            for (size_t i = 0; i < matches.size(); i++)
                st.removeCable(matches[i]);
        }
        return true;
    }

    if (type == "duplicate_module") {
        // Commit cannot execute this yet; preview must not promise it can
        // (spec section 6: the previewed plan is the plan commit applies).
        err = {"UNSUPPORTED_OPERATION",
               "duplicate_module is not implemented; use add_module with explicit "
               "set_parameter and connect operations"};
        return false;
    }

    err = {"UNSUPPORTED_OPERATION", "unknown operation '" + type + "'"};
    return false;
}

json_t* idStr(int64_t id) {
    return json_string(std::to_string(id).c_str());
}
json_t* idArray(const std::vector<int64_t>& ids) {
    json_t* a = json_array();
    for (int64_t id : ids)
        if (id >= 0)
            json_array_append_new(a, idStr(id));
    return a;
}

} // namespace

TxnOutcome txnPreview(json_t* request) {
    TxnOutcome out;
    json_t* operations = json_object_get(request, "operations");
    const char* label = jstr(request, "label", "transaction");
    if (!json_is_array(operations) || json_array_size(operations) == 0) {
        out.errorCode = "BAD_REQUEST";
        out.errorMessage = "operations must be a non-empty array";
        return out;
    }

    PreviewState st;
    ValidationError verr;
    size_t idx;
    json_t* op;
    json_array_foreach(operations, idx, op) {
        if (!validateOne(op, st, verr)) {
            out.errorCode = verr.code;
            out.errorMessage = "operation " + std::to_string(idx) + ": " + verr.message;
            return out;
        }
    }

    std::string baseFingerprint;
    if (!safeFingerprint(baseFingerprint)) {
        out.errorCode = "INTERNAL";
        out.errorMessage = "the patch fingerprint could not be computed";
        return out;
    }

    // Normalized plan = {label, operations}; hash canonically.
    json_t* plan = json_object();
    json_object_set_new(plan, "label", json_string(label));
    json_object_set(plan, "operations", operations); // borrow (incref)
    std::string planHash = canonicalFingerprint(plan);

    // Diff.
    json_t* diff = json_object();
    json_t* added = json_array();
    for (auto& a : st.addedModules) {
        json_t* e = json_pack("{s:s, s:s, s:s}", "alias", a.first.c_str(), "pluginSlug",
                              a.second.first.c_str(), "modelSlug", a.second.second.c_str());
        json_array_append_new(added, e);
    }
    json_object_set_new(diff, "addedModules", added);
    json_object_set_new(diff, "removedModuleIds", idArray(st.removedModules));
    json_object_set_new(diff, "movedModuleIds", idArray(st.movedModules));
    json_object_set_new(diff, "modifiedModuleIds", idArray(st.modifiedModules));
    json_object_set_new(diff, "addedCableCount", json_integer(st.addedCables));
    json_object_set_new(diff, "removedCableIds", idArray(st.removedCables));
    json_t* replaced = json_array();
    for (auto& p : st.replacedInputs)
        json_array_append_new(replaced, json_pack("{s:o, s:i}", "moduleId", idStr(p.first),
                                                  "portId", p.second));
    json_object_set_new(diff, "replacedInputPorts", replaced);
    json_t* stacked = json_array();
    for (auto& p : st.stackedInputs)
        json_array_append_new(stacked, json_pack("{s:o, s:i}", "moduleId", idStr(p.first), "portId",
                                                 p.second));
    json_object_set_new(diff, "stackedInputPorts", stacked);

    // Risk. Flag and level strings are the schema's RiskFlag / RiskLevel
    // vocabulary (packages/schemas/src/operations.ts); nothing else validates.
    bool destructive = !st.removedModules.empty() || !st.removedCables.empty() ||
                       !st.replacedInputs.empty() || st.removesBridge;
    bool randomizes = false;
    json_array_foreach(operations, idx, op) {
        if (std::string(jstr(op, "op")) == "randomize_module")
            randomizes = true;
    }

    json_t* flags = json_array();
    json_t* reasons = json_array();
    auto addFlag = [&](const char* flag, const std::string& reason) {
        json_array_append_new(flags, json_string(flag));
        json_array_append_new(reasons, json_string(reason.c_str()));
    };
    if (st.removesBridge)
        addFlag("removes_bridge", "removes a RackMCP-Bridge module");
    if (!st.removedModules.empty())
        addFlag("removes_modules",
                "removes " + std::to_string(st.removedModules.size()) + " module(s)");
    if (!st.removedCables.empty())
        addFlag("removes_cables",
                "removes " + std::to_string(st.removedCables.size()) + " cable(s)");
    if (!st.replacedInputs.empty())
        addFlag("replaces_cables",
                "replaces the cables on " + std::to_string(st.replacedInputs.size()) +
                    " input port(s)");
    if (!st.stackedInputs.empty())
        addFlag("stacks_inputs",
                "stacks " + std::to_string(st.stackedInputs.size()) + " input port(s)");
    if (randomizes)
        addFlag("randomize", "randomizes module parameters");
    if (st.touchesAudio)
        addFlag("affects_audio_path", "changes the audio-destination signal path");
    if (st.missingModule)
        addFlag("missing_modules", "a referenced model is not installed");
    if (st.adapterUncertainty)
        addFlag("adapter_uncertainty", "adds third-party modules without a verified adapter");
    if (st.possibleFeedback)
        addFlag("possible_feedback", "may create a feedback loop");
    // RiskLevel is low | destructive | high. Confirmation gating is unchanged:
    // audio-path and adapter concerns are carried by the flags, not the level.
    const char* level = st.removesBridge ? "high"
                        : ((destructive || randomizes) ? "destructive" : "low");
    bool confirmationRequired = destructive || randomizes || st.removesBridge;
    json_t* risk = json_object();
    json_object_set_new(risk, "level", json_string(level));
    json_object_set_new(risk, "flags", flags);
    json_object_set_new(risk, "reasons", reasons);
    json_object_set_new(risk, "confirmationRequired", json_boolean(confirmationRequired));

    json_t* warningsJ = json_array();
    for (auto& w : st.warnings)
        json_array_append_new(warningsJ, json_string(w.c_str()));

    json_t* payload = json_object();
    json_object_set_new(payload, "plan", plan);
    json_object_set_new(payload, "planHash", json_string(planHash.c_str()));
    json_object_set_new(payload, "baseFingerprint", json_string(baseFingerprint.c_str()));
    json_object_set_new(payload, "patchEpoch", json_integer(RackBridge::instance().patchEpoch()));
    json_object_set_new(payload, "diff", diff);
    json_object_set_new(payload, "risk", risk);
    json_object_set_new(payload, "undoable", json_true());
    json_object_set_new(payload, "warnings", warningsJ);
    out.payload = payload;
    return out;
}

// ---------------------------------------------------------------------------
// Commit: apply with rollback
// ---------------------------------------------------------------------------

namespace {

/** Parses a "#rrggbb" or "#rrggbbaa" color; falls back to a default. */
NVGcolor parseColor(const std::string& hex) {
    if (hex.size() >= 7 && hex[0] == '#') {
        auto hx = [&](int i) {
            auto v = [](char c) -> int {
                if (c >= '0' && c <= '9')
                    return c - '0';
                if (c >= 'a' && c <= 'f')
                    return c - 'a' + 10;
                if (c >= 'A' && c <= 'F')
                    return c - 'A' + 10;
                return 0;
            };
            return v(hex[i]) * 16 + v(hex[i + 1]);
        };
        int a = hex.size() >= 9 ? hx(7) : 255;
        return nvgRGBA(hx(1), hx(3), hx(5), a);
    }
    return nvgRGB(0xc8, 0x54, 0x2a);
}

struct AppliedOp {
    std::string op;
    std::string summary;
};

/** Applies the plan onto a ComplexAction; throws std::string on failure. */
class Applier {
public:
    Applier(history::ComplexAction* action) : action_(action) {}

    std::map<std::string, int64_t> aliasMap;
    std::vector<AppliedOp> applied;
    std::vector<std::string> warnings;
    /** Index of the operation being applied; the failing one when apply throws. */
    size_t currentIndex = 0;

    int64_t resolve(json_t* ref) {
        RefResult r = resolveRef(ref, aliasMap);
        if (!r.ok)
            throw std::string("unresolved module reference");
        return r.moduleId;
    }

    void apply(json_t* operations) {
        size_t idx;
        json_t* op;
        json_array_foreach(operations, idx, op) {
            currentIndex = idx;
            std::string type = jstr(op, "op");
            if (type == "add_module")
                applyAdd(op);
            else if (type == "remove_module")
                applyRemove(op);
            else if (type == "set_parameter")
                applySetParam(op);
            else if (type == "set_bypass")
                applyBypass(op);
            else if (type == "reset_module")
                applyReset(op);
            else if (type == "randomize_module")
                applyRandomize(op);
            else if (type == "move_module")
                applyMove(op);
            else if (type == "connect")
                applyConnect(op);
            else if (type == "disconnect")
                applyDisconnect(op);
            else if (type == "disconnect_port")
                applyDisconnectPort(op);
            else
                throw std::string("operation not implemented in commit: " + type);
        }
    }

private:
    history::ComplexAction* action_;

    /**
     * Records a ModuleMove for every module a placement call displaced, using
     * Rack's own drag bookkeeping. setModulePosForce/Squeeze push neighbours,
     * and an inverse that does not know about them cannot restore the layout.
     * Must be paired with updateModuleOldPositions() before the placement.
     */
    void pushModuleDragAction() {
        history::ComplexAction* drag = APP->scene->rack->getModuleDragAction();
        if (!drag)
            return;
        if (drag->isEmpty())
            delete drag;
        else
            action_->push(drag);
    }

    app::ModuleWidget* moduleWidget(int64_t id) {
        app::ModuleWidget* mw = APP->scene->rack->getModule(id);
        if (!mw)
            throw std::string("module widget missing for id " + std::to_string(id));
        return mw;
    }

    void applyAdd(json_t* op) {
        std::string pslug = jstr(op, "pluginSlug");
        std::string mslug = jstr(op, "modelSlug");
        std::string alias = jstr(op, "alias");
        plugin::Model* model = plugin::getModel(pslug, mslug);
        if (!model)
            throw std::string("model not installed: " + pslug + "/" + mslug);

        engine::Module* module = model->createModule();
        if (!module)
            throw std::string("failed to create module " + mslug);
        APP->engine->addModule(module);
        // Ownership moves twice here, and unwinding has to follow it exactly.
        // The engine holds `module` until createModuleWidget's setModule()
        // takes it over (ModuleWidget::module is documented "Owned"), after
        // which ~ModuleWidget itself calls Engine::removeModule and deletes it.
        // So a failed widget construction must never remove-and-delete the
        // module by hand: if the constructor threw after setModule(), the base
        // destructor already did, and doing it again trips Rack's
        // `it != internal->modules.end()` assert. Track the module by id and
        // ask the engine who still owns it rather than touching a pointer that
        // may already be freed.
        const int64_t moduleId = module->id;
        std::string widgetError;
        app::ModuleWidget* mw = NULL;
        try {
            mw = model->createModuleWidget(module);
        }
        catch (const std::exception& e) {
            widgetError = std::string(": ") + e.what();
        }
        catch (...) {
            widgetError = "";
        }
        if (!mw) {
            engine::Module* orphan = APP->engine->getModule(moduleId);
            if (orphan) {
                APP->engine->removeModule(orphan);
                delete orphan;
            }
            throw std::string("failed to create widget for " + mslug + widgetError);
        }
        try {
            APP->scene->rack->addModule(mw);
        }
        catch (const std::exception& e) {
            // addModule validates the panel size before it takes ownership of
            // the widget, so on a throw `mw` is still ours; deleting it also
            // removes `module` from the engine and deletes it.
            delete mw;
            throw std::string("failed to add " + mslug + " to the rack: " + e.what());
        }

        // Placement.
        std::string placement = jstr(op, "placement", "auto");
        math::Vec pos;
        if (placement == "at" && jhasKey(op, "position")) {
            json_t* p = json_object_get(op, "position");
            pos = gridToPixel((int) json_integer_value(json_object_get(p, "x")),
                              (int) json_integer_value(json_object_get(p, "y")));
        }
        else {
            pos = math::Vec(rightmostEdge(), gridToPixel(0, 0).y);
        }
        APP->scene->rack->updateModuleOldPositions();
        APP->scene->rack->setModulePosForce(mw, pos);

        // History (captures the added module for undo). Pushed before the drag
        // action so the inverse restores positions first, then removes the
        // module.
        history::ModuleAdd* h = new history::ModuleAdd;
        h->setModule(mw);
        action_->push(h);
        pushModuleDragAction();

        aliasMap[alias] = module->id;

        // Optional initial params.
        json_t* initial = json_object_get(op, "initialParams");
        if (json_is_array(initial)) {
            size_t i;
            json_t* pv;
            json_array_foreach(initial, i, pv) {
                int paramId = (int) json_integer_value(json_object_get(pv, "paramId"));
                if (paramId < 0 || paramId >= (int) module->params.size())
                    continue;
                setParamValue(module->id, paramId, pv);
            }
        }
        if (jbool(op, "bypassed", false))
            setBypassValue(module->id, true);

        applied.push_back({"add_module", pslug + "/" + mslug + " -> id " + std::to_string(module->id)});
    }

    void setParamValue(int64_t moduleId, int paramId, json_t* spec) {
        engine::Module* module = APP->engine->getModule(moduleId);
        if (!module)
            throw std::string("module gone during set_parameter");
        engine::ParamQuantity* pq = module->getParamQuantity(paramId);
        history::ParamChange* h = new history::ParamChange;
        h->moduleId = moduleId;
        h->paramId = paramId;
        // Read (and later write) the settled value: for a smoothEnabled param
        // Engine::getParamValue is the immediate, possibly mid-ramp value.
        h->oldValue = pq ? pq->getValue() : APP->engine->getParamValue(module, paramId);
        float newValue = h->oldValue;
        if (jhasKey(spec, "value")) {
            newValue = (float) json_number_value(json_object_get(spec, "value"));
        }
        else if (jhasKey(spec, "normalized") && pq) {
            float n = (float) json_number_value(json_object_get(spec, "normalized"));
            newValue = pq->minValue + n * (pq->maxValue - pq->minValue);
        }
        else if (jhasKey(spec, "display") && pq) {
            pq->setDisplayValueString(jstr(spec, "display"));
            newValue = pq->getValue();
        }
        if (pq) {
            // setValue() only sets the Engine's smoothing target when the param
            // has smoothEnabled, which would leave both this history entry and
            // the post-commit fingerprint reading a value the patch has not
            // reached yet. A transaction must land exactly and immediately.
            pq->setImmediateValue(newValue);
            h->newValue = pq->getValue();
        }
        else {
            APP->engine->setParamValue(module, paramId, newValue);
            h->newValue = APP->engine->getParamValue(module, paramId);
        }
        action_->push(h);
    }

    void applySetParam(json_t* op) {
        int64_t id = resolve(json_object_get(op, "module"));
        int paramId = (int) json_integer_value(json_object_get(op, "paramId"));
        engine::Module* module = APP->engine->getModule(id);
        if (!module || paramId < 0 || paramId >= (int) module->params.size())
            throw std::string("set_parameter: bad module/param");
        setParamValue(id, paramId, op);
        applied.push_back({"set_parameter", "module " + std::to_string(id) + " param " +
                                                std::to_string(paramId)});
    }

    void setBypassValue(int64_t moduleId, bool bypassed) {
        engine::Module* module = APP->engine->getModule(moduleId);
        if (!module)
            throw std::string("module gone during set_bypass");
        if (module->isBypassed() == bypassed)
            return;
        APP->engine->bypassModule(module, bypassed);
        history::ModuleBypass* h = new history::ModuleBypass;
        h->moduleId = moduleId;
        h->bypassed = bypassed;
        action_->push(h);
    }

    void applyBypass(json_t* op) {
        int64_t id = resolve(json_object_get(op, "module"));
        bool bypassed = jbool(op, "bypassed", true);
        setBypassValue(id, bypassed);
        applied.push_back({"set_bypass", "module " + std::to_string(id) + " -> " +
                                             (bypassed ? "bypassed" : "active")});
    }

    void applyReset(json_t* op) {
        int64_t id = resolve(json_object_get(op, "module"));
        app::ModuleWidget* mw = moduleWidget(id);
        // Snapshot before/after for a ModuleChange history entry.
        engine::Module* module = APP->engine->getModule(id);
        history::ModuleChange* h = new history::ModuleChange;
        h->moduleId = id;
        h->oldModuleJ = APP->engine->moduleToJson(module);
        APP->engine->resetModule(module);
        h->newModuleJ = APP->engine->moduleToJson(module);
        action_->push(h);
        (void) mw;
        applied.push_back({"reset_module", "module " + std::to_string(id)});
    }

    void applyRandomize(json_t* op) {
        int64_t id = resolve(json_object_get(op, "module"));
        engine::Module* module = APP->engine->getModule(id);
        if (!module)
            throw std::string("randomize_module: module gone");
        // Same shape as reset: a ModuleChange carries the whole state back.
        history::ModuleChange* h = new history::ModuleChange;
        h->moduleId = id;
        h->oldModuleJ = APP->engine->moduleToJson(module);
        APP->engine->randomizeModule(module);
        h->newModuleJ = APP->engine->moduleToJson(module);
        action_->push(h);
        applied.push_back({"randomize_module", "module " + std::to_string(id)});
    }

    void applyMove(json_t* op) {
        int64_t id = resolve(json_object_get(op, "module"));
        app::ModuleWidget* mw = moduleWidget(id);
        json_t* pos = json_object_get(op, "position");
        math::Vec target = gridToPixel((int) json_integer_value(json_object_get(pos, "x")),
                                       (int) json_integer_value(json_object_get(pos, "y")));
        // The schema field is `collision` (CollisionPolicy).
        std::string policy = jstr(op, "collision", "nearest");
        // force/squeeze displace neighbours; capture every module that moves.
        APP->scene->rack->updateModuleOldPositions();
        if (policy == "fail") {
            if (!APP->scene->rack->requestModulePos(mw, target))
                throw std::string("move_module: position occupied (collision fail)");
        }
        else if (policy == "force")
            APP->scene->rack->setModulePosForce(mw, target);
        else if (policy == "squeeze")
            APP->scene->rack->setModulePosSqueeze(mw, target);
        else
            APP->scene->rack->setModulePosNearest(mw, target);
        pushModuleDragAction();
        applied.push_back({"move_module", "module " + std::to_string(id)});
    }

    void removeCableById(int64_t cableId) {
        app::CableWidget* cw = APP->scene->rack->getCable(cableId);
        if (!cw)
            return;
        history::CableRemove* h = new history::CableRemove;
        h->setCable(cw);
        APP->scene->rack->removeCable(cw);
        delete cw;
        action_->push(h);
    }

    void applyConnect(json_t* op) {
        json_t* outRef = json_object_get(op, "output");
        json_t* inRef = json_object_get(op, "input");
        int64_t outId = resolve(json_object_get(outRef, "module"));
        int64_t inId = resolve(json_object_get(inRef, "module"));
        int outPort = (int) json_integer_value(json_object_get(outRef, "portId"));
        int inPort = (int) json_integer_value(json_object_get(inRef, "portId"));
        engine::Module* outMod = APP->engine->getModule(outId);
        engine::Module* inMod = APP->engine->getModule(inId);
        if (!outMod || !inMod)
            throw std::string("connect: module missing");
        if (outPort < 0 || outPort >= (int) outMod->outputs.size() || inPort < 0 ||
            inPort >= (int) inMod->inputs.size())
            throw std::string("connect: port out of range");

        std::string policy = jstr(op, "inputPolicy", "fail_if_connected");
        // Handle an already-connected input.
        std::vector<int64_t> existing;
        for (int64_t cid : APP->engine->getCableIds()) {
            engine::Cable* c = APP->engine->getCable(cid);
            if (c && c->inputModule && c->inputModule->id == inId && c->inputId == inPort)
                existing.push_back(cid);
        }
        if (!existing.empty()) {
            if (policy == "fail_if_connected")
                throw std::string("connect: input already connected");
            if (policy == "stack")
                throw std::string("connect: Rack inputs take one cable; use replace_all");
            for (int64_t cid : existing)
                removeCableById(cid); // replace_all
        }

        engine::Cable* cable = new engine::Cable;
        cable->outputModule = outMod;
        cable->outputId = outPort;
        cable->inputModule = inMod;
        cable->inputId = inPort;
        APP->engine->addCable(cable);

        app::CableWidget* cw = new app::CableWidget;
        cw->setCable(cable);
        cw->color = parseColor(jstr(op, "color", ""));
        APP->scene->rack->addCable(cw);

        history::CableAdd* h = new history::CableAdd;
        h->setCable(cw);
        action_->push(h);

        applied.push_back({"connect", std::to_string(outId) + ":" + std::to_string(outPort) + " -> " +
                                          std::to_string(inId) + ":" + std::to_string(inPort)});
    }

    void applyDisconnect(json_t* op) {
        const char* cidStr = jstr(json_object_get(op, "cable"), "cableId", "");
        int64_t cid = strtoll(cidStr, NULL, 10);
        if (!APP->engine->getCable(cid))
            throw std::string("disconnect: no cable " + std::string(cidStr));
        removeCableById(cid);
        applied.push_back({"disconnect", "cable " + std::string(cidStr)});
    }

    void applyDisconnectPort(json_t* op) {
        json_t* portRef = json_object_get(op, "port");
        int64_t id = resolve(json_object_get(portRef, "module"));
        int portId = (int) json_integer_value(json_object_get(portRef, "portId"));
        std::string ptype = jstr(portRef, "portType", "input");
        std::string policy = jstr(op, "policy", "all");
        std::vector<int64_t> matches;
        for (int64_t cid : APP->engine->getCableIds()) {
            engine::Cable* c = APP->engine->getCable(cid);
            if (!c)
                continue;
            bool hit = (ptype == "input" && c->inputModule && c->inputModule->id == id &&
                        c->inputId == portId) ||
                       (ptype == "output" && c->outputModule && c->outputModule->id == id &&
                        c->outputId == portId);
            if (hit)
                matches.push_back(cid);
        }
        if (policy == "top" && !matches.empty())
            matches = {matches.back()};
        for (int64_t cid : matches)
            removeCableById(cid);
        applied.push_back({"disconnect_port", "module " + std::to_string(id) + " " + ptype + " " +
                                                  std::to_string(portId)});
    }

    void applyRemove(json_t* op) {
        int64_t id = resolve(json_object_get(op, "module"));
        app::ModuleWidget* mw = moduleWidget(id);
        std::string cablePolicy = jstr(op, "cablePolicy", "remove_attached");
        // Remove attached cables first (each recorded for undo).
        std::vector<int64_t> attached;
        for (int64_t cid : APP->engine->getCableIds()) {
            engine::Cable* c = APP->engine->getCable(cid);
            if (c && ((c->inputModule && c->inputModule->id == id) ||
                      (c->outputModule && c->outputModule->id == id)))
                attached.push_back(cid);
        }
        if (!attached.empty() && cablePolicy == "fail_if_connected")
            throw std::string("remove_module: module has attached cables (policy "
                              "fail_if_connected)");
        for (int64_t cid : attached)
            removeCableById(cid);

        history::ModuleRemove* h = new history::ModuleRemove;
        h->setModule(mw);
        APP->scene->rack->removeModule(mw);
        delete mw;
        action_->push(h);
        applied.push_back({"remove_module", "module " + std::to_string(id)});
    }
};

} // namespace

TxnOutcome txnCommit(json_t* request) {
    TxnOutcome out;
    RackBridge& bridge = RackBridge::instance();

    json_t* plan = json_object_get(request, "plan");
    const char* planHashIn = jstr(request, "planHash", "");
    const char* expectedFp = jstr(request, "expectedFingerprint", "");
    const char* operationId = jstr(request, "operationId", "");
    if (!json_is_object(plan)) {
        out.errorCode = "BAD_REQUEST";
        out.errorMessage = "commit requires a plan";
        return out;
    }
    json_t* operations = json_object_get(plan, "operations");
    const char* label = jstr(plan, "label", "transaction");
    if (!json_is_array(operations) || json_array_size(operations) == 0) {
        out.errorCode = "BAD_REQUEST";
        out.errorMessage = "plan has no operations";
        return out;
    }

    // Plan-hash integrity: the plan must hash to the claimed value.
    std::string recomputed = canonicalFingerprint(plan);
    if (recomputed != planHashIn) {
        out.errorCode = "VALIDATION_FAILED";
        out.errorMessage = "plan hash mismatch (plan altered since preview)";
        return out;
    }

    // Fingerprint concurrency: reject if the patch changed since preview.
    std::string current;
    if (!safeFingerprint(current)) {
        out.errorCode = "INTERNAL";
        out.errorMessage = "the patch fingerprint could not be computed";
        return out;
    }
    if (std::string(expectedFp) != current) {
        out.errorCode = "PATCH_CONFLICT";
        out.errorMessage = "patch changed since preview; re-preview required";
        out.retrySafe = false;
        return out;
    }

    std::string oldFingerprint = current;
    int64_t startMs = steadyNowMs();
    std::string shortOp = std::string(operationId).substr(0, 8);
    history::ComplexAction* complex = new history::ComplexAction;
    complex->name = std::string("Rack MCP: ") + label + " [" + shortOp + "]";

    Applier applier(complex);
    bool applyFailed = false;
    std::string failMessage;
    try {
        applier.apply(operations);
    } catch (const std::string& e) {
        applyFailed = true;
        failMessage = e;
    } catch (const std::exception& e) {
        // Rack and third-party plugin code throw std::exception subclasses.
        applyFailed = true;
        failMessage = e.what();
    } catch (...) {
        applyFailed = true;
        failMessage = "unknown error during apply";
    }

    if (applyFailed) {
        // Counted whether or not the inverses prove complete: an indeterminate
        // rollback is still a rollback, and it is the one an operator most
        // needs to see in the metrics.
        RackBridge::instance().server().counters().rollbacks++;
        // Roll back everything applied so far via the ComplexAction inverses,
        // then discard it without pushing a history entry. Completeness is
        // proven against the pre-transaction fingerprint, never assumed: an
        // inverse can throw, and a half-applied operation (an engine module
        // whose widget never materialized, say) has no inverse at all.
        std::string rollbackDetail;
        bool rollbackThrew = false;
        try {
            complex->undo();
        }
        catch (const std::string& e) {
            rollbackThrew = true;
            rollbackDetail = e;
        }
        catch (const std::exception& e) {
            rollbackThrew = true;
            rollbackDetail = e.what();
        }
        catch (...) {
            rollbackThrew = true;
            rollbackDetail = "an inverse action threw";
        }
        delete complex;

        bool restored = false;
        if (!rollbackThrew) {
            std::string postFingerprint;
            if (safeFingerprint(postFingerprint))
                restored = (postFingerprint == oldFingerprint);
            else
                rollbackDetail = "the post-rollback fingerprint could not be computed";
        }

        std::string detail = "operation " + std::to_string(applier.currentIndex) + " failed: " +
                             failMessage;
        if (restored) {
            out.errorCode = "VALIDATION_FAILED";
            out.errorMessage = "transaction failed and was rolled back: " + failMessage;
            out.mutationMayHaveOccurred = false;
        }
        else {
            detail += "; rollback indeterminate";
            if (!rollbackDetail.empty())
                detail += ": " + rollbackDetail;
            else
                detail += ": the patch no longer matches its pre-transaction fingerprint";
            out.errorCode = "ROLLBACK_FAILED";
            out.errorMessage = "transaction failed and complete rollback could not be proven: " +
                               detail;
            out.mutationMayHaveOccurred = true;
        }
        out.retrySafe = false;
        json_t* rb = json_pack("{s:s, s:i, s:i, s:s}", "rolledBack",
                               restored ? "complete" : "indeterminate", "failedOperationIndex",
                               (int) applier.currentIndex, "inversesExecuted",
                               (int) applier.applied.size(), "detail", detail.c_str());
        out.payload = json_object();
        json_object_set_new(out.payload, "rollback", rb);
        return out;
    }

    // Success: push as one history action.
    APP->history->push(complex);
    std::string newFingerprint;
    if (!safeFingerprint(newFingerprint)) {
        // The mutation is applied and undoable, but unfingerprintable: report
        // it rather than letting the throw escape into Rack's frame loop.
        out.errorCode = "INTERNAL";
        out.errorMessage = "transaction applied but the patch fingerprint could not be computed";
        out.mutationMayHaveOccurred = true;
        return out;
    }

    json_t* payload = json_object();
    json_object_set_new(payload, "operationId", json_string(operationId));
    json_object_set_new(payload, "oldFingerprint", json_string(oldFingerprint.c_str()));
    json_object_set_new(payload, "newFingerprint", json_string(newFingerprint.c_str()));
    json_object_set_new(payload, "patchEpoch", json_integer(bridge.patchEpoch()));
    json_t* appliedJ = json_array();
    for (auto& a : applier.applied)
        json_array_append_new(appliedJ, json_pack("{s:s, s:s}", "op", a.op.c_str(), "summary",
                                                  a.summary.c_str()));
    json_object_set_new(payload, "applied", appliedJ);
    json_t* aliasJ = json_object();
    for (auto& kv : applier.aliasMap)
        json_object_set_new(aliasJ, kv.first.c_str(), idStr(kv.second));
    json_object_set_new(payload, "aliasToModuleId", aliasJ);
    json_t* warnJ = json_array();
    for (auto& w : applier.warnings)
        json_array_append_new(warnJ, json_string(w.c_str()));
    json_object_set_new(payload, "warnings", warnJ);
    json_object_set_new(payload, "undoEligible", json_true());
    json_object_set_new(payload, "durationMs", json_real((double) (steadyNowMs() - startMs)));
    json_object_set_new(payload, "replayed", json_false());

    // Record for undo eligibility + idempotency (the pump caches by op id).
    bridge.setLastMcpTransaction(operationId, newFingerprint);
    out.payload = payload;
    return out;
}

TxnOutcome txnUndoLast(json_t* request) {
    TxnOutcome out;
    RackBridge& bridge = RackBridge::instance();
    const char* expectedOp = jstr(request, "expectedOperationId", "");

    std::string lastOp, postFingerprint;
    if (!bridge.lastMcpTransaction(lastOp, postFingerprint) || lastOp != expectedOp) {
        out.errorCode = "VALIDATION_FAILED";
        out.errorMessage = "the identified MCP transaction is not the last recorded one";
        return out;
    }
    // Must still be on top of history and unmodified since.
    if (!APP->history->canUndo()) {
        out.errorCode = "VALIDATION_FAILED";
        out.errorMessage = "nothing to undo";
        return out;
    }
    std::string undoName = APP->history->getUndoName();
    std::string shortOp = std::string(expectedOp).substr(0, 8);
    if (undoName.find("[" + shortOp + "]") == std::string::npos) {
        out.errorCode = "VALIDATION_FAILED";
        out.errorMessage = "a manual action occurred after the MCP transaction; refusing to undo";
        return out;
    }
    std::string liveFingerprint;
    if (!safeFingerprint(liveFingerprint)) {
        out.errorCode = "INTERNAL";
        out.errorMessage = "the patch fingerprint could not be computed";
        return out;
    }
    if (liveFingerprint != postFingerprint) {
        out.errorCode = "PATCH_CONFLICT";
        out.errorMessage = "patch changed since the transaction; refusing to undo";
        return out;
    }
    APP->history->undo();
    bridge.clearLastMcpTransaction();
    std::string undoneFingerprint;
    if (!safeFingerprint(undoneFingerprint)) {
        out.errorCode = "INTERNAL";
        out.errorMessage = "the undo was applied but the patch fingerprint could not be computed";
        out.mutationMayHaveOccurred = true;
        return out;
    }
    json_t* payload = json_object();
    json_object_set_new(payload, "undone", json_true());
    json_object_set_new(payload, "newFingerprint", json_string(undoneFingerprint.c_str()));
    json_object_set_new(payload, "patchEpoch", json_integer(bridge.patchEpoch()));
    out.payload = payload;
    return out;
}

} // namespace rackmcp
