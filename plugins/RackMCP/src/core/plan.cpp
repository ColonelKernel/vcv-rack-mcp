#include "core/plan.hpp"

#include <climits>
#include <cstdlib>
#include <cstring>

namespace rackmcp {

bool isAudioModule(const WorldModule& module) {
    return module.pluginSlug == "Core" && module.modelSlug.rfind("Audio", 0) == 0;
}

bool isBridgeModule(const WorldModule& module) {
    return module.pluginSlug == "RackMCP" && module.modelSlug == "Bridge";
}

int remainingBridgeCount(const std::vector<WorldModule>& modules,
                         const std::vector<int64_t>& removed) {
    int n = 0;
    for (size_t i = 0; i < modules.size(); i++) {
        if (!isBridgeModule(modules[i]))
            continue;
        bool gone = false;
        for (size_t j = 0; j < removed.size(); j++)
            if (removed[j] == modules[i].id)
                gone = true;
        if (!gone)
            n++;
    }
    return n;
}


namespace {
std::string count(size_t n) {
    // to_string on size_t is ambiguous on some 32-bit targets; go through
    // unsigned long, which is wide enough for any plan (the allowance is 128).
    return std::to_string((unsigned long) n);
}
}  // namespace

bool parseDecimalId(const std::string& text, int64_t& out) {
    // ^(0|[1-9][0-9]{0,18})$ -- checked as a shape first, so no permissive
    // library parse can widen what counts as an id.
    if (text.empty() || text.size() > 19)
        return false;
    if (text[0] == '0') {
        // A single zero is the only id that may start with one.
        if (text.size() != 1)
            return false;
        out = 0;
        return true;
    }
    for (size_t i = 0; i < text.size(); i++)
        if (text[i] < '0' || text[i] > '9')
            return false;

    // The shape permits 19 digits, and 19 digits can still exceed INT64_MAX
    // (the schema's regex has the same gap). Accumulate with an explicit
    // overflow check rather than clamping the way strtoll does.
    int64_t value = 0;
    for (size_t i = 0; i < text.size(); i++) {
        const int digit = text[i] - '0';
        if (value > (INT64_MAX - digit) / 10)
            return false;
        value = value * 10 + digit;
    }
    out = value;
    return true;
}

#if RACKMCP_HAVE_JANSSON

namespace {

/** The JSON type name jansson reports, for the failure message. */
const char* actualTypeName(json_t* v) {
    if (!v) return "absent";
    switch (json_typeof(v)) {
        case JSON_OBJECT: return "object";
        case JSON_ARRAY: return "array";
        case JSON_STRING: return "string";
        case JSON_INTEGER: return "integer";
        case JSON_REAL: return "number";
        case JSON_TRUE:
        case JSON_FALSE: return "boolean";
        case JSON_NULL: return "null";
        default: return "unknown";
    }
}

/**
 * Whether a value satisfies a declared JSON type.
 *
 * An unrecognised declaration accepts anything, deliberately: `jsonTypeOf` in
 * scripts/gen-cpp.ts emits "any" for a union whose branches disagree, and a
 * future type name must not turn into a refusal of valid traffic when the
 * plugin is older than the schema.
 */
bool typeMatches(const char* declared, json_t* v) {
    if (!declared) return true;
    const std::string t(declared);
    if (t == "any") return true;
    if (t == "string") return json_is_string(v) != 0;
    if (t == "boolean") return json_is_boolean(v) != 0;
    if (t == "integer") return json_is_integer(v) != 0;
    // A schema "number" admits an integer; jansson types them separately.
    if (t == "number") return json_is_number(v) != 0;
    if (t == "object") return json_is_object(v) != 0;
    if (t == "array") return json_is_array(v) != 0;
    return true;
}

} // namespace

ParamTarget readParamTarget(json_t* spec) {
    ParamTarget out;
    if (!json_is_object(spec)) {
        out.error = "parameter target is not a JSON object";
        return out;
    }
    json_t* v = json_object_get(spec, "value");
    json_t* n = json_object_get(spec, "normalized");
    json_t* d = json_object_get(spec, "display");
    const int named = (v ? 1 : 0) + (n ? 1 : 0) + (d ? 1 : 0);
    if (named != 1) {
        out.error = named == 0
                        ? "exactly one of \"value\", \"normalized\" or \"display\" is required, "
                          "and none was given"
                        : "exactly one of \"value\", \"normalized\" or \"display\" is required, "
                          "and " + std::to_string(named) + " were given";
        return out;
    }
    if (v) {
        if (!json_is_number(v)) {
            out.error = std::string("\"value\" must be a number, not ") + actualTypeName(v);
            return out;
        }
        out.kind = ParamTargetKind::Value;
        out.number = json_number_value(v);
        return out;
    }
    if (n) {
        if (!json_is_number(n)) {
            out.error = std::string("\"normalized\" must be a number, not ") + actualTypeName(n);
            return out;
        }
        out.kind = ParamTargetKind::Normalized;
        out.number = json_number_value(n);
        return out;
    }
    if (!json_is_string(d)) {
        out.error = std::string("\"display\" must be a string, not ") + actualTypeName(d);
        return out;
    }
    out.kind = ParamTargetKind::Display;
    out.display = json_string_value(d);
    return out;
}

bool readIntField(json_t* obj, const char* key, int& out, std::string& err) {
    json_t* v = json_object_get(obj, key);
    if (!v) {
        err = std::string("missing required field \"") + key + "\"";
        return false;
    }
    if (!json_is_integer(v)) {
        err = std::string("field \"") + key + "\" must be an integer, not " + actualTypeName(v);
        return false;
    }
    const json_int_t raw = json_integer_value(v);
    // Checked BEFORE the narrowing cast, which is the whole point: casting
    // first turns an out-of-range id into an in-range one.
    if (raw < (json_int_t) INT_MIN || raw > (json_int_t) INT_MAX) {
        err = std::string("field \"") + key + "\" is out of range";
        return false;
    }
    out = (int) raw;
    return true;
}

std::string checkOperationFields(json_t* op) {
    if (!json_is_object(op))
        return "operation is not a JSON object";
    json_t* opName = json_object_get(op, "op");
    if (!json_is_string(opName))
        return "operation has no \"op\" string";
    const char* name = json_string_value(opName);

    const gen::OperationSpec* spec = NULL;
    for (size_t i = 0; i < gen::OPERATION_SPEC_COUNT; i++) {
        if (std::strcmp(gen::OPERATION_SPECS[i].op, name) == 0) {
            spec = &gen::OPERATION_SPECS[i];
            break;
        }
    }
    if (!spec)
        return ""; // unknown op: the caller reports UNSUPPORTED_OPERATION
    return checkDeclaredFields(name, spec->fields, spec->fieldCount, op);
}

std::string checkDeclaredFields(const char* what, const gen::FieldSpec* fields, size_t fieldCount,
                                json_t* obj) {
    const std::string name(what ? what : "request");
    if (!json_is_object(obj))
        return name + ": payload is not a JSON object";
    for (size_t i = 0; i < fieldCount; i++) {
        const gen::FieldSpec& field = fields[i];
        if (!field.name)
            break;
        json_t* value = json_object_get(obj, field.name);
        if (!value) {
            return name + ": missing required field \"" + field.name +
                   "\" (declared " + field.jsonType + ")";
        }
        if (!typeMatches(field.jsonType, value)) {
            return name + ": field \"" + field.name + "\" must be " +
                   field.jsonType + ", not " + actualTypeName(value);
        }
        // A string of the right type is not yet a string the schema admits, and
        // for the policy fields that distinction is the whole point: the plugin
        // reads them with jstr(op, key, <default>) and every one of those
        // defaults is the destructive choice. An unrecognised `cablePolicy`
        // selected remove_attached; an unrecognised `inputPolicy` selected
        // replace_all and deleted the existing cable.
        if (field.allowed && json_is_string(value)) {
            const char* actual = json_string_value(value);
            bool found = false;
            std::string permitted;
            for (size_t a = 0; field.allowed[a]; a++) {
                if (std::strcmp(field.allowed[a], actual) == 0)
                    found = true;
                if (!permitted.empty())
                    permitted += ", ";
                permitted += field.allowed[a];
            }
            if (!found) {
                return name + ": field \"" + field.name + "\" must be one of " +
                       permitted + ", not \"" + actual + "\"";
            }
        }
    }
    return "";
}

ModuleRef resolveModuleRef(json_t* ref, const std::map<std::string, int64_t>& aliases) {
    ModuleRef r;
    if (!json_is_object(ref))
        return r;

    json_t* mid = json_object_get(ref, "moduleId");
    if (json_is_string(mid)) {
        // Returns either way: a ref that names moduleId is a moduleId ref, and
        // a malformed one must not fall through to be read as an alias.
        r.ok = parseDecimalId(json_string_value(mid), r.moduleId);
        if (!r.ok)
            r.moduleId = -1;
        return r;
    }

    json_t* al = json_object_get(ref, "alias");
    if (json_is_string(al)) {
        r.isAlias = true;
        r.alias = json_string_value(al);
        std::map<std::string, int64_t>::const_iterator it = aliases.find(r.alias);
        if (it != aliases.end()) {
            r.ok = true;
            r.moduleId = it->second;
        }
    }
    return r;
}
#endif

PlanCable PlanCable::connected(int64_t id, int64_t outModule, int outPort, int64_t inModule,
                               int inPort) {
    PlanCable c;
    c.id = id;
    c.hasOutput = c.hasInput = true;
    c.outputModuleId = outModule;
    c.outputId = outPort;
    c.inputModuleId = inModule;
    c.inputId = inPort;
    return c;
}

namespace {
bool alreadyRemoved(const std::vector<int64_t>& removed, int64_t cableId) {
    for (size_t i = 0; i < removed.size(); i++)
        if (removed[i] == cableId)
            return true;
    return false;
}
}  // namespace

std::vector<int64_t> cablesOnModule(const std::vector<PlanCable>& cables,
                                    const std::vector<int64_t>& removed, int64_t moduleId) {
    std::vector<int64_t> hits;
    for (size_t i = 0; i < cables.size(); i++) {
        const PlanCable& c = cables[i];
        if (alreadyRemoved(removed, c.id))
            continue;
        if ((c.hasInput && c.inputModuleId == moduleId) ||
            (c.hasOutput && c.outputModuleId == moduleId))
            hits.push_back(c.id);
    }
    return hits;
}

std::vector<int64_t> cablesOnPort(const std::vector<PlanCable>& cables,
                                  const std::vector<int64_t>& removed, int64_t moduleId,
                                  const std::string& portType, int portId) {
    std::vector<int64_t> hits;
    for (size_t i = 0; i < cables.size(); i++) {
        const PlanCable& c = cables[i];
        if (alreadyRemoved(removed, c.id))
            continue;
        const bool hit =
            (portType == "input" && c.hasInput && c.inputModuleId == moduleId &&
             c.inputId == portId) ||
            (portType == "output" && c.hasOutput && c.outputModuleId == moduleId &&
             c.outputId == portId);
        if (hit)
            hits.push_back(c.id);
    }
    return hits;
}

bool PlanRisk::has(gen::RiskFlag flag) const {
    for (size_t i = 0; i < entries.size(); i++)
        if (entries[i].flag == flag)
            return true;
    return false;
}

PlanRisk computeRisk(const PlanEffects& e, int64_t maxOperations) {
    const bool destructive =
        e.removedModules > 0 || e.removedCables > 0 || e.replacedInputs > 0 || e.removesBridge;

    PlanRisk risk;
    // Order is observable: a client renders these in the order given, and the
    // most alarming thing a plan does should be the first thing read.
    if (e.removesBridge)
        risk.entries.push_back(
            RiskEntry(gen::RiskFlag::removes_bridge, "removes a RackMCP-Bridge module"));
    if (e.removedModules > 0)
        risk.entries.push_back(RiskEntry(gen::RiskFlag::removes_modules,
                                         "removes " + count(e.removedModules) + " module(s)"));
    if (e.removedCables > 0)
        risk.entries.push_back(RiskEntry(gen::RiskFlag::removes_cables,
                                         "removes " + count(e.removedCables) + " cable(s)"));
    if (e.replacedInputs > 0)
        risk.entries.push_back(
            RiskEntry(gen::RiskFlag::replaces_cables,
                      "replaces the cables on " + count(e.replacedInputs) + " input port(s)"));
    if (e.stackedInputs > 0)
        risk.entries.push_back(RiskEntry(gen::RiskFlag::stacks_inputs,
                                         "stacks " + count(e.stackedInputs) + " input port(s)"));
    if (e.randomizes)
        risk.entries.push_back(
            RiskEntry(gen::RiskFlag::randomize, "randomizes module parameters"));
    if (e.touchesAudio)
        risk.entries.push_back(RiskEntry(gen::RiskFlag::affects_audio_path,
                                         "changes the audio-destination signal path"));
    if (e.missingModule)
        risk.entries.push_back(
            RiskEntry(gen::RiskFlag::missing_modules, "a referenced model is not installed"));
    if (e.adapterUncertainty)
        risk.entries.push_back(RiskEntry(gen::RiskFlag::adapter_uncertainty,
                                         "adds third-party modules without a verified adapter"));
    if (e.possibleFeedback)
        risk.entries.push_back(
            RiskEntry(gen::RiskFlag::possible_feedback, "may create a feedback loop"));
    // Strictly more than half the allowance. Exactly half is not flagged: the
    // point is "this is getting large", not "this is at the boundary".
    if (maxOperations > 0 && (int64_t) e.operationCount * 2 > maxOperations)
        risk.entries.push_back(
            RiskEntry(gen::RiskFlag::large_transaction,
                      "applies " + count(e.operationCount) +
                          " operations in one transaction (limit " +
                          std::to_string((long) maxOperations) + ")"));

    risk.level = e.removesBridge ? "high" : ((destructive || e.randomizes) ? "destructive" : "low");
    // `|| e.removesBridge` is deliberately absent: removesBridge is already a
    // term of `destructive` above, so the original spelling
    // (destructive || randomizes || removesBridge) had a term that could not
    // change the answer -- and therefore could not be tested either. Dropping
    // it makes the containment load-bearing, which is what the assertion in
    // plan.test.cpp about removing only the bridge now checks.
    risk.confirmationRequired = destructive || e.randomizes;
    return risk;
}

}  // namespace rackmcp
