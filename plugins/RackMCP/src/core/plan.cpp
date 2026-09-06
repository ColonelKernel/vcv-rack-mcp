#include "core/plan.hpp"

#include <cstdlib>

namespace rackmcp {

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
