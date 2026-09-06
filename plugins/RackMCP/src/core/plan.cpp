#include "core/plan.hpp"

namespace rackmcp {

namespace {
std::string count(size_t n) {
    // to_string on size_t is ambiguous on some 32-bit targets; go through
    // unsigned long, which is wide enough for any plan (the allowance is 128).
    return std::to_string((unsigned long) n);
}
}  // namespace

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
