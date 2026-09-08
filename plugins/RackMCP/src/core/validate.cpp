// Transaction validation over a snapshot. See core/validate.hpp.
#include "core/validate.hpp"

#if RACKMCP_HAVE_JANSSON

#include <cstddef>

#include "core/layout.hpp"
#include "core/plan.hpp"

namespace rackmcp {

namespace {

/**
 * The lenient accessors this validation has always used, kept lenient on
 * purpose.
 *
 * Each substitutes a default for a value of the wrong type, and several of
 * those defaults are the destructive choice -- which is exactly why
 * `checkOperationFields` runs first, against the generated field table, before
 * any of them is reached. Tightening them here instead would move the check to
 * a place that cannot say which field was wrong.
 */
const char* jstr(json_t* o, const char* key, const char* dflt = "") {
    json_t* v = o ? json_object_get(o, key) : NULL;
    return json_is_string(v) ? json_string_value(v) : dflt;
}
bool jbool(json_t* o, const char* key, bool dflt) {
    json_t* v = o ? json_object_get(o, key) : NULL;
    return json_is_boolean(v) ? json_is_true(v) : dflt;
}

/** Keeps the 30-odd call sites below spelled as they were. */
typedef ModuleRef RefResult;
RefResult resolveRef(json_t* ref, const std::map<std::string, int64_t>& aliases) {
    return resolveModuleRef(ref, aliases);
}

} // namespace

const WorldModule* liveModule(const PlanWorld& world, const PreviewState& st, int64_t moduleId) {
    if (st.moduleRemoved(moduleId))
        return NULL;
    return world.module(moduleId);
}

std::vector<int64_t> cablesOnModule(const PlanWorld& world, const PreviewState& st,
                                    int64_t moduleId) {
    return rackmcp::cablesOnModule(world.cables, st.removedCables, moduleId);
}

std::vector<int64_t> cablesOnPort(const PlanWorld& world, const PreviewState& st, int64_t moduleId,
                                  const std::string& portType, int portId) {
    return rackmcp::cablesOnPort(world.cables, st.removedCables, moduleId, portType, portId);
}

bool positionFree(const PlanWorld& world, const PreviewState& st, size_t selfIndex,
                  const layout::Box& box) {
    layout::PlanLayout plan;
    plan.removedModules = st.removedModules;
    for (std::map<int64_t, layout::Box>::const_iterator it = st.plannedBoxes.begin();
         it != st.plannedBoxes.end(); ++it)
        plan.plannedBoxes[it->first] = it->second;
    return layout::positionFree(world.occupants, selfIndex, box, plan);
}

bool validateOne(json_t* op, const PlanWorld& world, PreviewState& st, ValidationError& err) {
    std::string type = jstr(op, "op");

    // Every field the schema declares required, present and of the declared
    // type, before any accessor gets a chance to substitute a default. The
    // accessors below (jbool, json_integer_value, jstr) all return a default
    // for a value of the wrong type, and several of those defaults are the
    // destructive choice.
    const std::string shape = checkOperationFields(op);
    if (!shape.empty()) {
        err = {"BAD_REQUEST", shape};
        return false;
    }

    if (type == "add_module") {
        std::string pslug = jstr(op, "pluginSlug");
        std::string mslug = jstr(op, "modelSlug");
        std::string alias = jstr(op, "alias");
        if (!world.modelInstalled(pslug, mslug)) {
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
            const WorldModule* m = liveModule(world, st, r.moduleId);
            if (!m) {
                err = {"MODULE_NOT_FOUND", "no module with id " + std::to_string(r.moduleId)};
                return false;
            }
            bool isBridge = rackmcp::isBridgeModule(*m);
            // Counted against the plan, not against the live patch. The live
            // count is the patch as it was before this transaction, so it never
            // saw a Bridge an earlier operation here had already removed.
            const int bridgesLeft = remainingBridgeCount(world.modules, st.removedModules);
            if (isBridge && !jbool(op, "allowLastBridge", false) && bridgesLeft <= 1) {
                err = {"UNSUPPORTED_OPERATION",
                       "refusing to remove the last RackMCP-Bridge module (set allowLastBridge)"};
                st.removesBridge = true;
                return false;
            }
            if (isBridge)
                st.removesBridge = true;
            if (rackmcp::isAudioModule(*m))
                st.touchesAudio = true;
            // The cable policy decides between refusing and taking the cables
            // with the module; either way the diff must list them.
            std::string cablePolicy = jstr(op, "cablePolicy", "remove_attached");
            std::vector<int64_t> attached = cablesOnModule(world, st, r.moduleId);
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
            const WorldModule* m = liveModule(world, st, r.moduleId);
            if (!m) {
                err = {"MODULE_NOT_FOUND", "no module with id " + std::to_string(r.moduleId)};
                return false;
            }
            if (type == "set_parameter") {
                int paramId = 0;
                std::string ierr;
                if (!readIntField(op, "paramId", paramId, ierr)) {
                    err = {"BAD_REQUEST", "set_parameter: " + ierr};
                    return false;
                }
                if (paramId < 0 || (size_t) paramId >= m->paramCount) {
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
            if (!liveModule(world, st, r.moduleId)) {
                err = {"MODULE_NOT_FOUND", "no module with id " + std::to_string(r.moduleId)};
                return false;
            }
            // The panel `RackWidget::getModule(id)` would have returned, as an
            // index into the same occupant list the collision check reads --
            // resolved in one pass, so the panel exempted from the check and
            // the panel whose size defines the target box cannot disagree.
            const size_t selfIndex = world.widgetIndex(r.moduleId);
            if (selfIndex != layout::kNoSelf) {
                json_t* p = json_object_get(op, "position");
                int gx = 0, gy = 0;
                std::string ierr;
                if (!readGridPosition(p, gx, gy, ierr)) {
                    err = {"BAD_REQUEST", "move_module: position " + ierr};
                    return false;
                }
                layout::Box target(layout::gridToPixel(gx, gy, world.grid),
                                   world.occupants[selfIndex].box.size);
                // Only refuse when the resulting layout is known exactly:
                // apply-time requestModulePos stays the authority, and a
                // preview must never reject a plan that would have committed.
                if (policy == "fail" && !st.layoutUncertain &&
                    !positionFree(world, st, selfIndex, target)) {
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
        int outId = 0, inId = 0;
        {
            std::string ierr;
            if (!readIntField(outRef, "portId", outId, ierr)) {
                err = {"BAD_REQUEST", "connect: output " + ierr};
                return false;
            }
            if (!readIntField(inRef, "portId", inId, ierr)) {
                err = {"BAD_REQUEST", "connect: input " + ierr};
                return false;
            }
        }
        std::string policy = jstr(op, "inputPolicy", "fail_if_connected");
        // Bounds check against live modules (synthetic modules validated at apply).
        if (out.moduleId >= 0) {
            const WorldModule* m = liveModule(world, st, out.moduleId);
            if (!m || outId < 0 || (size_t) outId >= m->outputCount) {
                err = {"PORT_NOT_FOUND", "connect: output port out of range"};
                return false;
            }
            if (rackmcp::isAudioModule(*m))
                st.touchesAudio = true;
        }
        // Input already connected -- by a live cable the plan keeps, or by an
        // earlier connect in this same plan.
        bool connected = st.inputClaimed(in.moduleId, inId);
        std::vector<int64_t> existing;
        if (in.moduleId >= 0) {
            const WorldModule* m = liveModule(world, st, in.moduleId);
            if (!m || inId < 0 || (size_t) inId >= m->inputCount) {
                err = {"PORT_NOT_FOUND", "connect: input port out of range"};
                return false;
            }
            if (rackmcp::isAudioModule(*m))
                st.touchesAudio = true;
            existing = cablesOnPort(world, st, in.moduleId, "input", inId);
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
        // The endptr check alone accepted "" as cable 0 -- strtoll returns 0 and
        // leaves endp on the terminator -- and never checked the sign, so a
        // negative id reached getCable too.
        int64_t cid = -1;
        if (!parseDecimalId(cidStr, cid) || !world.hasCable(cid)) {
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
            const WorldModule* m = liveModule(world, st, r.moduleId);
            if (!m) {
                err = {"MODULE_NOT_FOUND", "no module with id " + std::to_string(r.moduleId)};
                return false;
            }
            if (rackmcp::isAudioModule(*m))
                st.touchesAudio = true;
            // Enumerate exactly what apply will remove, so the diff discloses
            // the cables and the destructive classification picks them up.
            int portId = 0;
            std::string ierr;
            if (!readIntField(portRef, "portId", portId, ierr)) {
                err = {"BAD_REQUEST", "disconnect_port: " + ierr};
                return false;
            }
            // portType is nested, so the generated field table does not reach
            // it. An unrecognised value made cablesOnPort match nothing and
            // disconnect_port a silent no-op that still reported success.
            const std::string ptype = jstr(portRef, "portType", "");
            if (ptype != "input" && ptype != "output") {
                err = {"BAD_REQUEST",
                       "disconnect_port: portType must be \"input\" or \"output\", not \"" +
                           ptype + "\""};
                return false;
            }
            std::string policy = jstr(op, "policy", "all");
            std::vector<int64_t> matches = cablesOnPort(world, st, r.moduleId, ptype, portId);
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

} // namespace rackmcp
#endif // RACKMCP_HAVE_JANSSON
