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
#include "core/layout.hpp"
#include "core/plan.hpp"
#include "core/validate.hpp"
#include "core/rollback.hpp"
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

/**
 * Resolves a module reference. The parsing and precedence live in core/plan.cpp
 * so they can be tested; this alias keeps the 30-odd call sites unchanged.
 */
typedef ModuleRef RefResult;
static RefResult resolveRef(json_t* ref, const std::map<std::string, int64_t>& aliases) {
    return resolveModuleRef(ref, aliases);
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

/**
 * Rack's grid, handed to core/layout so no SDK constant is copied there.
 *
 * RACK_GRID_WIDTH is `static const float`, which C++11 cannot use in a
 * constant expression, so a copy in core/ could not be static_assert-ed
 * against it -- and a runtime or text check would have to live in tests/cpp,
 * whose CI job never fetches the SDK and therefore could never fail. Passing
 * the values means there is nothing to keep in sync.
 */
static layout::Grid rackGrid() {
    return layout::Grid(RACK_GRID_WIDTH, RACK_GRID_HEIGHT);
}

static layout::Box toBox(const math::Rect& r) {
    return layout::Box(r.pos.x, r.pos.y, r.size.x, r.size.y);
}

static math::Vec gridToPixel(int gx, int gy) {
    const layout::Point p = layout::gridToPixel(gx, gy, rackGrid());
    return math::Vec(p.x, p.y);
}

/**
 * Rightmost occupied pixel x, for automatic placement.
 *
 * Reads the panels fresh on every call, deliberately. applyAdd installs the
 * new widget and only then asks where to put it, so this must see the rack as
 * it is at that moment; reusing a snapshot taken during preview would place
 * two auto-added modules at the same x, commit successfully, change the
 * fingerprint and assert nothing.
 */
static float rightmostEdge() {
    std::vector<layout::Occupant> occupants;
    for (int64_t id : APP->engine->getModuleIds()) {
        app::ModuleWidget* mw = APP->scene->rack->getModule(id);
        if (mw)
            occupants.push_back(layout::Occupant(id, toBox(mw->box)));
    }
    return layout::rightmostEdge(occupants, rackGrid());
}

// ---------------------------------------------------------------------------
// Preview: validation without mutation
// ---------------------------------------------------------------------------

namespace {

/**
 * A live module as plain data.
 *
 * Every slug comparison downstream goes through this rather than chasing
 * `m->model->plugin->slug` at the point of use: the two-pointer guard was
 * written out three times in this file with no test on any copy, and the
 * predicates it feeds decide a risk flag the client is shown and the refusal
 * that stops a transaction severing its own control channel. A module with no
 * model becomes two empty slugs, which is what preserves the guard.
 */
WorldModule toWorldModule(int64_t id, engine::Module* m) {
    if (m && m->model && m->model->plugin)
        return WorldModule(id, m->model->plugin->slug, m->model->slug, m->params.size(),
                           m->inputs.size(), m->outputs.size());
    if (m)
        return WorldModule(id, "", "", m->params.size(), m->inputs.size(), m->outputs.size());
    return WorldModule(id, "", "");
}

/**
 * Every Rack read validation needs, taken once, in one place.
 *
 * This is the whole reason `core/validate.cpp` can be a pure function and can
 * be tested on three platforms in CI: after this returns, nothing downstream
 * touches Rack. Each capture below replaces reads that used to happen at the
 * point of use, sometimes several times per operation.
 *
 * `installedModels` holds only the models THIS plan names and Rack resolved --
 * not every model on the machine. The whole catalogue was the obvious design
 * and is worse twice over: it is more work than the lookups it replaces (a
 * large install is several thousand models, walked on the UI thread inside one
 * pump step, whether or not the plan adds anything), and reimplementing the
 * lookup invites divergence from `plugin::getModel`, which
 * `docs/spec/rack-mcp-spec.md` requires preview and apply to agree on.
 * Pre-resolving with `getModel` itself makes the same calls in the same order
 * and merely moves them earlier, so its behaviour is preserved by construction
 * rather than by argument -- including its treatment of an empty slug, and its
 * deliberate difference from `getModelFallback`, which neither preview nor
 * apply uses.
 *
 * The panels are captured in `getModules()` order, with a NULL `module` kept as
 * an id-less occupant: such a panel can never be the module being moved, but it
 * is still an obstacle, and dropping it would let a plan place a module on top
 * of one. Walking the list here instead of calling `RackWidget::getModule(id)`
 * per operation is also the only null-safe way to ask the question -- that
 * function dereferences `widget->module->id` with no null check (0xe5db8 in the
 * vendored 2.6.6 dylib), so one module-less panel would crash the process.
 *
 * The cables are captured once rather than re-read per check. Disclosed in
 * core/validate.hpp as a contract change rather than claimed as identity: the
 * UI thread cannot mutate during validation, but a third-party module's worker
 * thread can, and fresh-per-call reads then describe several instants at once.
 */
PlanWorld snapshotWorld(json_t* operations) {
    PlanWorld world(rackGrid());
    for (int64_t id : APP->engine->getModuleIds())
        world.modules.push_back(toWorldModule(id, APP->engine->getModule(id)));

    std::vector<app::ModuleWidget*> mws = APP->scene->rack->getModules();
    for (size_t i = 0; i < mws.size(); i++) {
        app::ModuleWidget* mw = mws[i];
        if (!mw)
            continue;
        world.occupants.push_back(mw->module
                                      ? layout::Occupant(mw->module->id, toBox(mw->box))
                                      : layout::Occupant(toBox(mw->box)));
    }

    for (int64_t cid : APP->engine->getCableIds()) {
        engine::Cable* c = APP->engine->getCable(cid);
        if (!c)
            continue;
        PlanCable pc;
        pc.id = cid;
        if (c->outputModule) {
            pc.hasOutput = true;
            pc.outputModuleId = c->outputModule->id;
            pc.outputId = c->outputId;
        }
        if (c->inputModule) {
            pc.hasInput = true;
            pc.inputModuleId = c->inputModule->id;
            pc.inputId = c->inputId;
        }
        world.cables.push_back(pc);
    }

    size_t i;
    json_t* op;
    json_array_foreach(operations, i, op) {
        if (std::string(jstr(op, "op")) != "add_module")
            continue;
        std::string pslug = jstr(op, "pluginSlug");
        std::string mslug = jstr(op, "modelSlug");
        if (plugin::getModel(pslug, mslug))
            world.installedModels.insert(ModelRef(pslug, mslug));
    }
    return world;
}

bool isAudioModule(engine::Module* m) {
    return m && rackmcp::isAudioModule(toWorldModule(m->id, m));
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

    // Sampled BEFORE validation, deliberately.
    //
    // baseFingerprint is what the client hands back as expectedFingerprint, and
    // txnCommit refuses to apply when it no longer matches the live patch. Taken
    // AFTER the validation loop -- as it was -- the value does not cover the
    // validation window itself: a mutation landing between the last validateOne
    // and the sample yields a diff describing the patch as it WAS and a
    // fingerprint describing the patch as it now IS, so the commit gate sees
    // agreement and applies a plan validated against a patch that no longer
    // exists. Sampling first inverts that: the fingerprint is then stale with
    // respect to the mutation, the gate fires, and the client re-previews.
    // Refusing is the correct outcome; committing quietly is not.
    //
    // Only a mutation from another thread can reach this window -- txnPreview
    // runs on the UI thread inside one CommandPumpWidget::step(), so the user
    // cannot act during it -- but engine::Engine's mutators are public and
    // lock-protected rather than UI-thread-asserted, so a third-party module
    // with a worker thread can. There is no test for this: reproducing it needs
    // real concurrency against a running Rack, and the harness does not even
    // step the engine. The ordering is the whole defence, hence this comment.
    //
    // The FAILURE is reported after the loop, so a plan that is both invalid and
    // unfingerprintable still returns its validation error, exactly as before.
    std::string baseFingerprint;
    const bool fingerprintTaken = safeFingerprint(baseFingerprint);

    // Taken after the fingerprint, never before. The fingerprint must never be
    // older than the world it certifies: sampling the world first lets a
    // mutation land in between, leaving the plan validated against the old
    // patch while expectedFingerprint matches the new one -- so the commit gate
    // agrees and applies a plan that was checked against something else. This
    // is the same argument as the comment above, in the other direction.
    const PlanWorld world = snapshotWorld(operations);

    PreviewState st;
    ValidationError verr;
    size_t idx;
    json_t* op;
    json_array_foreach(operations, idx, op) {
        if (!validateOne(op, world, st, verr)) {
            out.errorCode = verr.code;
            out.errorMessage = "operation " + std::to_string(idx) + ": " + verr.message;
            return out;
        }
    }

    if (!fingerprintTaken) {
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

    // Risk. The classification itself is core/plan.cpp, where it can be tested;
    // this only gathers what validation found and serialises the answer.
    PlanEffects effects;
    effects.removesBridge = st.removesBridge;
    effects.touchesAudio = st.touchesAudio;
    effects.missingModule = st.missingModule;
    effects.adapterUncertainty = st.adapterUncertainty;
    effects.possibleFeedback = st.possibleFeedback;
    effects.removedModules = st.removedModules.size();
    effects.removedCables = st.removedCables.size();
    effects.replacedInputs = st.replacedInputs.size();
    effects.stackedInputs = st.stackedInputs.size();
    effects.operationCount = json_array_size(operations);
    json_array_foreach(operations, idx, op) {
        if (std::string(jstr(op, "op")) == "randomize_module")
            effects.randomizes = true;
    }

    const PlanRisk planRisk = computeRisk(effects, gen::LIMIT_TXN_MAX_OPERATIONS);
    json_t* flags = json_array();
    json_t* reasons = json_array();
    for (size_t i = 0; i < planRisk.entries.size(); i++) {
        json_array_append_new(flags, json_string(planRisk.entries[i].name()));
        json_array_append_new(reasons, json_string(planRisk.entries[i].reason.c_str()));
    }
    json_t* risk = json_object();
    json_object_set_new(risk, "level", json_string(planRisk.level.c_str()));
    json_object_set_new(risk, "flags", flags);
    json_object_set_new(risk, "reasons", reasons);
    json_object_set_new(risk, "confirmationRequired", json_boolean(planRisk.confirmationRequired));

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
            int gx = 0, gy = 0;
            std::string ierr;
            if (!readGridPosition(p, gx, gy, ierr))
                throw std::string("add_module: position " + ierr);
            pos = gridToPixel(gx, gy);
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
                int paramId = 0;
                std::string ierr;
                if (!readIntField(pv, "paramId", paramId, ierr))
                    throw std::string("add_module: initialParams[" + std::to_string(i) + "] " +
                                      ierr);
                // Skipped silently before, and the transaction then reported
                // success -- so "add this module with these settings" could
                // half-happen and say it had happened. set_parameter treats the
                // identical condition as a hard error. Preview cannot catch
                // this one: the module does not exist yet, so its parameter
                // count is unknown until the module is created here.
                if (paramId < 0 || paramId >= (int) module->params.size())
                    throw std::string("add_module: initialParams[" + std::to_string(i) +
                                      "] param " + std::to_string(paramId) + " out of range (" +
                                      mslug + " has " + std::to_string(module->params.size()) +
                                      ")");
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
        const ParamTarget target = readParamTarget(spec);
        if (!target.error.empty()) {
            delete h;
            throw std::string("set_parameter: " + target.error);
        }
        if (target.kind == ParamTargetKind::Value) {
            newValue = (float) target.number;
        }
        else {
            // Both remaining forms are expressed in terms of the parameter's
            // own range, so neither is meaningful without a ParamQuantity.
            // Falling through as before left the value untouched and reported
            // the operation as applied.
            if (!pq) {
                delete h;
                throw std::string("set_parameter: param " + std::to_string(paramId) +
                                  " on module " + std::to_string(moduleId) +
                                  " has no quantity, so \"normalized\" and \"display\" cannot be "
                                  "interpreted; use \"value\"");
            }
            if (target.kind == ParamTargetKind::Normalized) {
                newValue = pq->minValue + (float) target.number * (pq->maxValue - pq->minValue);
            }
            else {
                pq->setDisplayValueString(target.display);
                newValue = pq->getValue();
            }
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
        int paramId = 0;
        {
            std::string ierr;
            if (!readIntField(op, "paramId", paramId, ierr))
                throw std::string("set_parameter: " + ierr);
        }
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
        int gx = 0, gy = 0;
        {
            std::string ierr;
            if (!readGridPosition(pos, gx, gy, ierr))
                throw std::string("move_module: position " + ierr);
        }
        math::Vec target = gridToPixel(gx, gy);
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
        int outPort = 0, inPort = 0;
        {
            std::string ierr;
            if (!readIntField(outRef, "portId", outPort, ierr))
                throw std::string("connect: output " + ierr);
            if (!readIntField(inRef, "portId", inPort, ierr))
                throw std::string("connect: input " + ierr);
        }
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
        // Parsed the SAME way preview parses it. This had no endptr check at
        // all, so preview and commit disagreed about what a cable id is:
        // "42x" was refused at preview and would have been read as 42 here.
        // Only a previewed plan reaches this path today, so the divergence was
        // latent rather than reachable -- but the two must not drift.
        int64_t cid = -1;
        if (!parseDecimalId(cidStr, cid) || !APP->engine->getCable(cid))
            throw std::string("disconnect: no cable " + std::string(cidStr));
        removeCableById(cid);
        applied.push_back({"disconnect", "cable " + std::string(cidStr)});
    }

    void applyDisconnectPort(json_t* op) {
        json_t* portRef = json_object_get(op, "port");
        int64_t id = resolve(json_object_get(portRef, "module"));
        int portId = 0;
        {
            std::string ierr;
            if (!readIntField(portRef, "portId", portId, ierr))
                throw std::string("disconnect_port: " + ierr);
        }
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

    // Commit re-checks the operation shapes rather than trusting preview to
    // have done it. The plan-hash gate below proves the plan hashes to the
    // value the caller claims, but that value is recomputed from the submitted
    // plan -- it is self-consistent for any plan, and no record of previously
    // previewed hashes exists -- so a commit can carry operations no preview
    // ever saw.
    {
        size_t i;
        json_t* op;
        json_array_foreach(operations, i, op) {
            const std::string shape = checkOperationFields(op);
            if (!shape.empty()) {
                out.errorCode = "BAD_REQUEST";
                out.errorMessage = "operation " + std::to_string(i) + ": " + shape;
                return out;
            }
        }
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
        //
        // Run the inverses here rather than calling ComplexAction::undo, which
        // is the same reverse loop with no bookkeeping (confirmed against the
        // shipped libRack, whose header only declares it). The difference is
        // that this one can be counted: undo() reports nothing, and the list
        // length is unreadable afterwards because the ComplexAction is deleted
        // before the report is packed -- and would over-report anyway, since a
        // throwing inverse abandons every older one behind it.
        const InverseRun rollback = runInverses(complex->actions);
        const bool rollbackThrew = rollback.threw;
        std::string rollbackDetail = rollback.detail;
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
                               (int) rollback.executed, "detail", detail.c_str());
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
