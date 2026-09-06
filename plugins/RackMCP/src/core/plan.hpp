#pragma once
// Risk classification for a validated transaction plan.
//
// This decides whether the client is asked to confirm before a patch is
// changed, which makes it the safety-relevant output of a preview -- and it
// had no test, because it was written inline in Transaction.cpp between live
// Rack reads. Nothing about the classification needs Rack: it is a function of
// what the plan was found to do.
//
// Flag names come from the generated RiskFlag enum rather than string
// literals, so a flag renamed in packages/schemas/src/operations.ts breaks the
// build here instead of silently emitting a word no client recognises.
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#include "gen/rackmcp_protocol_gen.hpp"

namespace rackmcp {

/**
 * What validation found the plan would do. Counts rather than lists: risk only
 * ever asks how many, and the diff reports which.
 */
struct PlanEffects {
    bool removesBridge;
    bool touchesAudio;
    bool missingModule;
    bool adapterUncertainty;
    bool possibleFeedback;
    bool randomizes;
    size_t removedModules;
    size_t removedCables;
    size_t replacedInputs;
    size_t stackedInputs;
    size_t operationCount;

    PlanEffects()
        : removesBridge(false), touchesAudio(false), missingModule(false),
          adapterUncertainty(false), possibleFeedback(false), randomizes(false),
          removedModules(0), removedCables(0), replacedInputs(0), stackedInputs(0),
          operationCount(0) {}
};

/** One flag and the sentence shown beside it. */
struct RiskEntry {
    gen::RiskFlag flag;
    std::string reason;
    RiskEntry(gen::RiskFlag flag_, const std::string& reason_) : flag(flag_), reason(reason_) {}
    const char* name() const { return gen::riskFlagToString(flag); }
};

struct PlanRisk {
    /** "low" | "destructive" | "high", the schema's RiskLevel. */
    std::string level;
    bool confirmationRequired;
    std::vector<RiskEntry> entries;
    PlanRisk() : confirmationRequired(false) {}
    bool has(gen::RiskFlag flag) const;
};

/**
 * Classifies a validated plan.
 *
 * `maxOperations` is the per-transaction allowance; a plan using more than half
 * of it is flagged so a client can offer to split, which says nothing about
 * validity. Passed in rather than read from gen:: directly so the threshold is
 * testable at both sides of the boundary.
 *
 * Destructiveness is removal and replacement only. Stacking an input adds a
 * cable beside an existing one and takes nothing away, so it is reported and
 * does not gate. Missing models and adapter uncertainty likewise: they are
 * carried by flags, and the level stays low.
 */
PlanRisk computeRisk(const PlanEffects& effects, int64_t maxOperations);

}  // namespace rackmcp
