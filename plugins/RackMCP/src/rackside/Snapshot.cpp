#include "rackside/Snapshot.hpp"

#include <rack.hpp>

#include <patch.hpp>
#include <plugin.hpp>
#include <tag.hpp>

#include <algorithm>
#include <cstdlib>
#include <list>
#include <map>
#include <string>
#include <vector>
#include <jansson.h>

#include "core/canonical.hpp"
#include "rackside/RackBridge.hpp"

namespace rackmcp {

using namespace rack;

/**
 * jansson's json_real() returns NULL for NaN/infinity, and
 * json_object_set_new() with a NULL value sets nothing — the key would simply
 * vanish from the payload and break the strict output schema. Rack allows
 * unbounded params (configParam with +/-INFINITY bounds), so emit an explicit
 * null for a non-finite value instead: "unbounded", not "missing".
 */
static json_t* realOrNull(double v) {
    if (v != v || v > 1.7976931348623157e308 || v < -1.7976931348623157e308)
        return json_null();
    return json_real(v);
}

// Decimal-string ids at every boundary (spec section 5).
static json_t* idStr(int64_t id) {
    return json_string(std::to_string(id).c_str());
}

static json_t* buildParam(engine::Module* module, int paramId) {
    engine::ParamQuantity* pq = module->getParamQuantity(paramId);
    json_t* p = json_object();
    json_object_set_new(p, "paramId", json_integer(paramId));
    if (pq) {
        json_object_set_new(p, "name", json_string(pq->name.c_str()));
        json_object_set_new(p, "value", realOrNull(pq->getValue()));
        json_object_set_new(p, "minValue", realOrNull(pq->minValue));
        json_object_set_new(p, "maxValue", realOrNull(pq->maxValue));
        json_object_set_new(p, "defaultValue", realOrNull(pq->defaultValue));
        float range = pq->maxValue - pq->minValue;
        float norm = range != 0.f ? (pq->getValue() - pq->minValue) / range : 0.f;
        json_object_set_new(p, "normalizedValue", realOrNull(norm));
        json_object_set_new(p, "displayValue", json_string(pq->getDisplayValueString().c_str()));
        json_object_set_new(p, "unit", json_string(pq->getUnit().c_str()));
        json_object_set_new(p, "snapped", json_boolean(pq->snapEnabled));
    }
    else {
        json_object_set_new(p, "name", json_string(""));
        json_object_set_new(p, "value", realOrNull(module->params[paramId].getValue()));
        json_object_set_new(p, "minValue", json_null());
        json_object_set_new(p, "maxValue", json_null());
        json_object_set_new(p, "defaultValue", json_null());
        json_object_set_new(p, "normalizedValue", json_null());
        json_object_set_new(p, "displayValue", json_null());
        json_object_set_new(p, "unit", json_string(""));
        json_object_set_new(p, "snapped", json_false());
    }
    return p;
}

static json_t* buildPort(engine::Module* module, int portId, bool isInput) {
    engine::PortInfo* info = isInput ? (portId < (int) module->inputInfos.size() ? module->inputInfos[portId] : NULL)
                                     : (portId < (int) module->outputInfos.size() ? module->outputInfos[portId] : NULL);
    engine::Port& port = isInput ? (engine::Port&) module->inputs[portId] : (engine::Port&) module->outputs[portId];
    json_t* p = json_object();
    json_object_set_new(p, "portId", json_integer(portId));
    json_object_set_new(p, "type", json_string(isInput ? "input" : "output"));
    json_object_set_new(p, "name", json_string(info ? info->getName().c_str() : ""));
    json_object_set_new(p, "channels", json_integer(port.getChannels()));
    json_object_set_new(p, "connected", json_boolean(port.isConnected()));
    return p;
}

/**
 * A parameter as the *model* declares it: static bounds and naming only.
 * `labels` is present only for switch-style params (SwitchQuantity), which is
 * the one case where the raw value is not self-describing.
 */
static json_t* buildModelParam(engine::Module* module, int paramId) {
    engine::ParamQuantity* pq = module->getParamQuantity(paramId);
    json_t* p = json_object();
    json_object_set_new(p, "paramId", json_integer(paramId));
    std::string name = pq ? pq->name : std::string();
    std::string unit = pq ? pq->getUnit() : std::string();
    truncateUtf8(name, 256);
    truncateUtf8(unit, 64);
    json_object_set_new(p, "name", json_string(name.c_str()));
    json_object_set_new(p, "unit", json_string(unit.c_str()));
    json_object_set_new(p, "minValue", realOrNull(pq ? pq->minValue : 0.f));
    json_object_set_new(p, "maxValue", realOrNull(pq ? pq->maxValue : 0.f));
    json_object_set_new(p, "defaultValue", realOrNull(pq ? pq->defaultValue : 0.f));
    engine::SwitchQuantity* sq = dynamic_cast<engine::SwitchQuantity*>(pq);
    if (sq && !sq->labels.empty()) {
        json_t* labels = json_array();
        for (size_t i = 0; i < sq->labels.size() && i < 64; i++) {
            std::string label = sq->labels[i];
            truncateUtf8(label, 128);
            json_array_append_new(labels, json_string(label.c_str()));
        }
        json_object_set_new(p, "labels", labels);
    }
    return p;
}

/** A port as the model declares it: id and name, no live channel state. */
static json_t* buildModelPort(engine::Module* module, int portId, bool isInput) {
    engine::PortInfo* info =
        isInput ? (portId < (int) module->inputInfos.size() ? module->inputInfos[portId] : NULL)
                : (portId < (int) module->outputInfos.size() ? module->outputInfos[portId] : NULL);
    std::string name = info ? info->getName() : std::string();
    truncateUtf8(name, 256);
    json_t* p = json_object();
    json_object_set_new(p, "portId", json_integer(portId));
    json_object_set_new(p, "name", json_string(name.c_str()));
    return p;
}

static bool isRackMcpBridge(engine::Module* module) {
    return module->model && module->model->plugin &&
           module->model->plugin->slug == "RackMCP" && module->model->slug == "Bridge";
}
static bool isRackMcpProbe(engine::Module* module) {
    return module->model && module->model->plugin &&
           module->model->plugin->slug == "RackMCP" && module->model->slug == "Probe";
}

static json_t* buildOneModule(engine::Module* module, bool includeOpaqueState) {
    json_t* m = json_object();
    json_object_set_new(m, "moduleId", idStr(module->id));
    plugin::Model* model = module->model;
    json_object_set_new(m, "pluginSlug", json_string(model && model->plugin ? model->plugin->slug.c_str() : ""));
    json_object_set_new(m, "pluginVersion",
                        json_string(model && model->plugin ? model->plugin->version.c_str() : ""));
    json_object_set_new(m, "modelSlug", json_string(model ? model->slug.c_str() : ""));
    json_object_set_new(m, "modelName", json_string(model ? model->name.c_str() : ""));
    json_object_set_new(m, "bypassed", json_boolean(module->isBypassed()));
    json_object_set_new(m, "isBridge", json_boolean(isRackMcpBridge(module)));
    json_object_set_new(m, "isProbe", json_boolean(isRackMcpProbe(module)));

    // Grid position and size from the widget (UI thread).
    app::ModuleWidget* widget = APP->scene->rack->getModule(module->id);
    if (widget) {
        math::Vec pos = widget->getGridPosition();
        math::Vec size = widget->getGridSize();
        json_t* posJ = json_pack("{s:i, s:i}", "x", (int) std::round(pos.x), "y", (int) std::round(pos.y));
        json_object_set_new(m, "gridPosition", posJ);
        json_object_set_new(m, "gridWidth", json_integer((int) std::round(size.x)));
    }
    else {
        json_object_set_new(m, "gridPosition", json_null());
        json_object_set_new(m, "gridWidth", json_null());
    }

    json_t* params = json_array();
    for (int i = 0; i < (int) module->params.size(); i++)
        json_array_append_new(params, buildParam(module, i));
    json_object_set_new(m, "params", params);

    json_t* inputs = json_array();
    for (int i = 0; i < (int) module->inputs.size(); i++)
        json_array_append_new(inputs, buildPort(module, i, true));
    json_object_set_new(m, "inputs", inputs);

    json_t* outputs = json_array();
    for (int i = 0; i < (int) module->outputs.size(); i++)
        json_array_append_new(outputs, buildPort(module, i, false));
    json_object_set_new(m, "outputs", outputs);

    // Expander adjacency.
    json_t* exp = json_object();
    json_object_set_new(exp, "left",
                        module->leftExpander.moduleId >= 0 ? idStr(module->leftExpander.moduleId)
                                                           : json_null());
    json_object_set_new(exp, "right",
                        module->rightExpander.moduleId >= 0 ? idStr(module->rightExpander.moduleId)
                                                            : json_null());
    json_object_set_new(m, "expanders", exp);

    if (includeOpaqueState) {
        // Disclosure-labeled opaque state via the engine's module serializer.
        json_t* data = APP->engine->moduleToJson(module);
        json_object_set_new(m, "opaqueState", data ? data : json_null());
        json_object_set_new(m, "opaqueStateDisclosed", json_true());
    }
    return m;
}

json_t* buildModuleSnapshot(int64_t moduleId, bool includeOpaqueState) {
    engine::Module* module = APP->engine->getModule(moduleId);
    if (!module)
        return NULL;
    return buildOneModule(module, includeOpaqueState);
}

json_t* buildPatchSnapshot(bool includeOpaqueState) {
    RackBridge& bridge = RackBridge::instance();
    json_t* root = json_object();
    json_object_set_new(root, "rackVersion", json_string(bridge.rackVersion().c_str()));
    json_object_set_new(root, "rackEdition", json_string(bridge.rackEdition().c_str()));
    json_object_set_new(root, "instanceId", json_string(bridge.instanceId().c_str()));
    json_object_set_new(root, "sessionId", json_string(bridge.sessionId().c_str()));
    json_object_set_new(root, "patchEpoch", json_integer(bridge.patchEpoch()));

    UiStateCache state = bridge.uiState();
    json_object_set_new(root, "patchName",
                        state.patchName.empty() ? json_null() : json_string(state.patchName.c_str()));
    json_object_set_new(root, "saved", json_boolean(state.saved));
    json_object_set_new(root, "sampleRate",
                        json_real(APP->engine ? APP->engine->getSampleRate() : 0.0));

    std::vector<int64_t> moduleIds = APP->engine->getModuleIds();
    std::sort(moduleIds.begin(), moduleIds.end());
    json_t* modules = json_array();
    int bridgeCount = 0, probeCount = 0;
    for (int64_t id : moduleIds) {
        engine::Module* module = APP->engine->getModule(id);
        if (!module)
            continue;
        if (isRackMcpBridge(module))
            bridgeCount++;
        if (isRackMcpProbe(module))
            probeCount++;
        json_array_append_new(modules, buildOneModule(module, includeOpaqueState));
    }
    json_object_set_new(root, "modules", modules);

    std::vector<int64_t> cableIds = APP->engine->getCableIds();
    std::sort(cableIds.begin(), cableIds.end());
    json_t* cables = json_array();
    for (int64_t id : cableIds) {
        engine::Cable* cable = APP->engine->getCable(id);
        if (!cable || !cable->outputModule || !cable->inputModule)
            continue;
        json_t* c = json_object();
        json_object_set_new(c, "cableId", idStr(id));
        json_object_set_new(c, "outputModuleId", idStr(cable->outputModule->id));
        json_object_set_new(c, "outputId", json_integer(cable->outputId));
        json_object_set_new(c, "inputModuleId", idStr(cable->inputModule->id));
        json_object_set_new(c, "inputId", json_integer(cable->inputId));
        app::CableWidget* cw = APP->scene->rack->getCable(id);
        json_object_set_new(c, "color", json_string(cw ? color::toHexString(cw->color).c_str() : ""));
        json_array_append_new(cables, c);
    }
    json_object_set_new(root, "cables", cables);

    json_object_set_new(root, "bridgeModuleCount", json_integer(bridgeCount));
    json_object_set_new(root, "probeModuleCount", json_integer(probeCount));
    json_object_set_new(root, "fingerprint", json_string(computePatchFingerprint().c_str()));
    json_object_set_new(root, "warnings", json_array());
    return root;
}

std::string computePatchFingerprint() {
    // Hash the complete serialized patch (opaque data, positions, cables, UI
    // state included) after canonicalization. Concurrency control only.
    json_t* patchJson = APP->patch ? APP->patch->toJson() : NULL;
    if (!patchJson)
        return std::string(64, '0');
    std::string fp = canonicalFingerprint(patchJson);
    json_decref(patchJson);
    return fp;
}

/**
 * The wire shape shared by `catalog.listModels` items and the `model` block of
 * `catalog.inspectModel` (CatalogModelInfo). Plugin metadata is untrusted text
 * (spec section 14): every field is clamped to the schema bound on a UTF-8
 * boundary, because a split sequence would make jansson drop the string.
 */
static json_t* buildModelInfo(plugin::Model* m) {
    plugin::Plugin* p = m->plugin;
    std::string pluginSlug = p ? p->slug : std::string();
    std::string pluginName = p ? p->name : std::string();
    std::string pluginVersion = p ? p->version : std::string();
    std::string modelSlug = m->slug;
    std::string modelName = m->name;
    std::string description = m->description;
    truncateUtf8(pluginSlug, 255);
    truncateUtf8(pluginName, 256);
    truncateUtf8(pluginVersion, 64);
    truncateUtf8(modelSlug, 255);
    truncateUtf8(modelName, 256);
    truncateUtf8(description, 2048);

    json_t* tags = json_array();
    for (std::list<int>::const_iterator it = m->tagIds.begin(); it != m->tagIds.end(); ++it) {
        if (json_array_size(tags) >= 32)
            break;
        std::string tagName = tag::getTag(*it);
        if (tagName.empty())
            continue;
        truncateUtf8(tagName, 64);
        json_array_append_new(tags, json_string(tagName.c_str()));
    }

    json_t* info = json_object();
    json_object_set_new(info, "pluginSlug", json_string(pluginSlug.c_str()));
    json_object_set_new(info, "pluginName", json_string(pluginName.c_str()));
    json_object_set_new(info, "pluginVersion", json_string(pluginVersion.c_str()));
    json_object_set_new(info, "modelSlug", json_string(modelSlug.c_str()));
    json_object_set_new(info, "modelName", json_string(modelName.c_str()));
    json_object_set_new(info, "description", json_string(description.c_str()));
    json_object_set_new(info, "tags", tags);
    return info;
}

json_t* buildModelCatalog(const std::string& cursor, int limit, const std::string& query) {
    // Flatten installed plugins -> models, deterministic ordering, then page by
    // an opaque numeric cursor.
    std::vector<plugin::Model*> all;
    std::string q = query;
    std::transform(q.begin(), q.end(), q.begin(), ::tolower);
    for (plugin::Plugin* p : plugin::plugins) {
        for (plugin::Model* m : p->models) {
            if (!q.empty()) {
                std::string hay = p->slug + " " + p->name + " " + m->slug + " " + m->name;
                std::transform(hay.begin(), hay.end(), hay.begin(), ::tolower);
                if (hay.find(q) == std::string::npos)
                    continue;
            }
            all.push_back(m);
        }
    }
    std::sort(all.begin(), all.end(), [](plugin::Model* a, plugin::Model* b) {
        std::string as = a->plugin ? a->plugin->slug : std::string();
        std::string bs = b->plugin ? b->plugin->slug : std::string();
        if (as != bs)
            return as < bs;
        return a->slug < b->slug;
    });

    size_t start = 0;
    if (!cursor.empty()) {
        try {
            start = (size_t) std::stoul(cursor);
        } catch (...) {
            start = 0;
        }
    }
    if (start > all.size())
        start = all.size();
    size_t end = std::min(all.size(), start + (size_t) limit);

    json_t* models = json_array();
    for (size_t i = start; i < end; i++)
        json_array_append_new(models, buildModelInfo(all[i]));
    json_t* root = json_object();
    json_object_set_new(root, "models", models);
    json_object_set_new(root, "totalModels", json_integer((json_int_t) all.size()));
    json_object_set_new(root, "nextCursor",
                        end < all.size() ? json_string(std::to_string(end).c_str()) : json_null());
    return root;
}

/**
 * Model metadata is immutable for a given plugin version within one Rack run,
 * so the expensive part — instantiating a throwaway engine module on the UI
 * thread — is done once per plugin/model/version and the result replayed.
 * The cache stores the serialized payload rather than a live json_t*: reparsing
 * a few KB is nothing next to constructing a DSP module, and it keeps refcount
 * ownership entirely inside this function.
 *
 * Unsynchronized on purpose: every handler reaches this through
 * executeCommand(), whose sole caller is the UI-thread command pump. A network
 * thread must never call it.
 */
static std::map<std::string, std::string>& modelMetadataCache() {
    static std::map<std::string, std::string> cache;
    return cache;
}

json_t* inspectModelMetadata(const std::string& pluginSlug, const std::string& modelSlug,
                             std::string& errorCode) {
    plugin::Model* model = plugin::getModel(pluginSlug, modelSlug);
    if (!model) {
        errorCode = "MODEL_NOT_INSTALLED";
        return NULL;
    }

    const std::string pluginVersion = model->plugin ? model->plugin->version : std::string();
    // NUL separators: slugs and versions are untrusted, and a printable
    // delimiter could be forged to collide two distinct models.
    const std::string cacheKey =
        pluginSlug + std::string(1, '\0') + modelSlug + std::string(1, '\0') + pluginVersion;
    std::map<std::string, std::string>& cache = modelMetadataCache();
    std::map<std::string, std::string>::const_iterator hit = cache.find(cacheKey);
    if (hit != cache.end()) {
        json_error_t jerr;
        json_t* replay = json_loads(hit->second.c_str(), 0, &jerr);
        if (replay) {
            json_object_set_new(replay, "cached", json_true());
            return replay;
        }
        cache.erase(cacheKey); // unparseable: fall through and rebuild
    }

    // Temporary engine module ONLY (never added to the patch); cleaned up here.
    engine::Module* module = model->createModule();
    if (!module) {
        errorCode = "UNSUPPORTED_OPERATION";
        return NULL;
    }
    json_t* root = json_object();
    json_object_set_new(root, "model", buildModelInfo(model));

    // Model metadata, not live state: a temporary instance's values are always
    // the defaults and its ports are always unconnected, so reporting value /
    // displayValue / channels / connected here would be noise that reads as
    // fact. inspect_module is the tool that reports live state.
    json_t* params = json_array();
    for (int i = 0; i < (int) module->params.size(); i++)
        json_array_append_new(params, buildModelParam(module, i));
    json_object_set_new(root, "params", params);

    json_t* inputs = json_array();
    for (int i = 0; i < (int) module->inputs.size(); i++)
        json_array_append_new(inputs, buildModelPort(module, i, true));
    json_object_set_new(root, "inputs", inputs);

    json_t* outputs = json_array();
    for (int i = 0; i < (int) module->outputs.size(); i++)
        json_array_append_new(outputs, buildModelPort(module, i, false));
    json_object_set_new(root, "outputs", outputs);

    json_object_set_new(root, "requiredTemporaryInstantiation", json_true());
    // This call is the one that paid for the instantiation.
    json_object_set_new(root, "cached", json_false());

    delete module;

    // Cache the freshly built payload for replay. Bounded so a pathological
    // plugin set cannot grow it without limit; metadata is small and the
    // working set is the handful of models a session actually inspects.
    if (cache.size() < 512) {
        char* dumped = json_dumps(root, JSON_COMPACT);
        if (dumped) {
            cache[cacheKey] = dumped;
            free(dumped);
        }
    }
    return root;
}

} // namespace rackmcp
