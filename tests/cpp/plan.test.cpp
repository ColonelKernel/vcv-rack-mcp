#include <doctest.h>
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>
#include "core/plan.hpp"

using namespace rackmcp;

static const int64_t kMaxOps = gen::LIMIT_TXN_MAX_OPERATIONS;

/** A plan that does nothing alarming. */
static PlanEffects benign() {
    PlanEffects e;
    e.operationCount = 2;
    return e;
}

static std::vector<std::string> names(const PlanRisk& r) {
    std::vector<std::string> out;
    for (size_t i = 0; i < r.entries.size(); i++)
        out.push_back(r.entries[i].name());
    return out;
}

TEST_CASE("a plan that only adds things is low risk and needs no confirmation") {
    PlanEffects e = benign();
    const PlanRisk r = computeRisk(e, kMaxOps);
    CHECK(r.level == "low");
    CHECK_FALSE(r.confirmationRequired);
    CHECK(r.entries.empty());
}

TEST_CASE("removal is destructive and gates the commit") {
    PlanEffects e = benign();
    e.removedModules = 1;
    const PlanRisk r = computeRisk(e, kMaxOps);
    CHECK(r.level == "destructive");
    CHECK(r.confirmationRequired);
    CHECK(r.has(gen::RiskFlag::removes_modules));
}

TEST_CASE("each removal kind independently gates") {
    // Written out rather than looped: if any one of these stopped gating, a
    // patch would be modified without the user being asked.
    for (int which = 0; which < 3; which++) {
        PlanEffects e = benign();
        if (which == 0) e.removedModules = 1;
        if (which == 1) e.removedCables = 1;
        if (which == 2) e.replacedInputs = 1;
        const PlanRisk r = computeRisk(e, kMaxOps);
        CHECK(r.confirmationRequired);
        CHECK(r.level == "destructive");
    }
}

TEST_CASE("removing the bridge is the only thing that reaches high") {
    PlanEffects e = benign();
    e.removedModules = 5;
    e.removedCables = 5;
    e.replacedInputs = 5;
    e.randomizes = true;
    e.touchesAudio = true;
    e.possibleFeedback = true;
    CHECK(computeRisk(e, kMaxOps).level == "destructive");

    e.removesBridge = true;
    const PlanRisk r = computeRisk(e, kMaxOps);
    CHECK(r.level == "high");
    CHECK(r.confirmationRequired);
    // And it is reported first, before the other nine.
    REQUIRE_FALSE(r.entries.empty());
    CHECK(std::string(r.entries[0].name()) == "removes_bridge");
}

TEST_CASE("removing the bridge gates even when nothing else happens") {
    // removesBridge is not counted in removedModules by this struct, so it has
    // to be a term of `destructive` in its own right. If it were dropped from
    // there, this plan would report level "high" -- the most alarming value --
    // while confirmationRequired went false, and the patch would be changed
    // without anyone being asked. The two are computed from one expression
    // precisely so they cannot disagree.
    PlanEffects e = benign();
    e.removesBridge = true;
    const PlanRisk r = computeRisk(e, kMaxOps);
    CHECK(r.level == "high");
    CHECK(r.confirmationRequired);
    CHECK(r.has(gen::RiskFlag::removes_bridge));
}

TEST_CASE("a high-risk plan always requires confirmation") {
    // The pairing stated as an invariant rather than as one example. There is
    // no combination of effects that produces "high" without gating.
    for (int bits = 0; bits < 64; bits++) {
        PlanEffects e;
        e.operationCount = 3;
        e.removesBridge = (bits & 1) != 0;
        e.randomizes = (bits & 2) != 0;
        e.touchesAudio = (bits & 4) != 0;
        e.missingModule = (bits & 8) != 0;
        e.adapterUncertainty = (bits & 16) != 0;
        e.possibleFeedback = (bits & 32) != 0;
        const PlanRisk r = computeRisk(e, kMaxOps);
        if (r.level == "high")
            CHECK(r.confirmationRequired);
        if (r.level == "destructive")
            CHECK(r.confirmationRequired);
        if (!r.confirmationRequired)
            CHECK(r.level == "low");
    }
}

TEST_CASE("randomizing is destructive without removing anything") {
    PlanEffects e = benign();
    e.randomizes = true;
    const PlanRisk r = computeRisk(e, kMaxOps);
    CHECK(r.level == "destructive");
    CHECK(r.confirmationRequired);
    CHECK(r.has(gen::RiskFlag::randomize));
}

TEST_CASE("stacking an input is reported but does not gate") {
    // Stacking adds a cable beside an existing one and removes nothing. If it
    // gated, every polyphonic patch build would stop for a confirmation.
    PlanEffects e = benign();
    e.stackedInputs = 3;
    const PlanRisk r = computeRisk(e, kMaxOps);
    CHECK(r.level == "low");
    CHECK_FALSE(r.confirmationRequired);
    CHECK(r.has(gen::RiskFlag::stacks_inputs));
}

TEST_CASE("advisory findings are reported without gating") {
    // The opposite failure to the one above: these must not be silently
    // dropped just because they do not require confirmation.
    PlanEffects e = benign();
    e.touchesAudio = true;
    e.missingModule = true;
    e.adapterUncertainty = true;
    e.possibleFeedback = true;
    const PlanRisk r = computeRisk(e, kMaxOps);
    CHECK(r.level == "low");
    CHECK_FALSE(r.confirmationRequired);
    CHECK(r.has(gen::RiskFlag::affects_audio_path));
    CHECK(r.has(gen::RiskFlag::missing_modules));
    CHECK(r.has(gen::RiskFlag::adapter_uncertainty));
    CHECK(r.has(gen::RiskFlag::possible_feedback));
}

TEST_CASE("the large-transaction threshold is strictly more than half") {
    PlanEffects e = benign();

    e.operationCount = (size_t) (kMaxOps / 2);
    CHECK_FALSE(computeRisk(e, kMaxOps).has(gen::RiskFlag::large_transaction));

    e.operationCount = (size_t) (kMaxOps / 2) + 1;
    CHECK(computeRisk(e, kMaxOps).has(gen::RiskFlag::large_transaction));

    // Size alone never gates: splitting is an offer, not a requirement.
    CHECK(computeRisk(e, kMaxOps).level == "low");
    CHECK_FALSE(computeRisk(e, kMaxOps).confirmationRequired);
}

TEST_CASE("the threshold follows the limit it is given") {
    // The flag exists so a client can offer to split; tying it to a separately
    // chosen number would let it drift away from the allowance it describes.
    PlanEffects e = benign();
    e.operationCount = 11;
    CHECK(computeRisk(e, 20).has(gen::RiskFlag::large_transaction));
    CHECK_FALSE(computeRisk(e, 200).has(gen::RiskFlag::large_transaction));
}

TEST_CASE("the reason names the number it is talking about") {
    // A reason is what the user reads before deciding. "removes some modules"
    // is not a basis for a decision.
    PlanEffects e = benign();
    e.removedModules = 7;
    e.removedCables = 4;
    const PlanRisk r = computeRisk(e, kMaxOps);
    REQUIRE(r.entries.size() == 2);
    CHECK(r.entries[0].reason == "removes 7 module(s)");
    CHECK(r.entries[1].reason == "removes 4 cable(s)");
}

TEST_CASE("flags come out in a fixed order") {
    PlanEffects e;
    e.removesBridge = true;
    e.removedModules = 1;
    e.removedCables = 1;
    e.replacedInputs = 1;
    e.stackedInputs = 1;
    e.randomizes = true;
    e.touchesAudio = true;
    e.missingModule = true;
    e.adapterUncertainty = true;
    e.possibleFeedback = true;
    e.operationCount = (size_t) kMaxOps;

    const std::vector<std::string> expected = {
        "removes_bridge",     "removes_modules",     "removes_cables",  "replaces_cables",
        "stacks_inputs",      "randomize",           "affects_audio_path", "missing_modules",
        "adapter_uncertainty", "possible_feedback",  "large_transaction"};
    CHECK(names(computeRisk(e, kMaxOps)) == expected);
}

TEST_CASE("every flag it can emit is one the schema declares") {
    // Guaranteed by construction now that the flags are the generated enum
    // rather than string literals -- which is the point. This fails only if
    // riskFlagToString gains a hole, and it costs one assertion to say so.
    PlanEffects e;
    e.removesBridge = true;
    e.removedModules = e.removedCables = e.replacedInputs = e.stackedInputs = 1;
    e.randomizes = e.touchesAudio = e.missingModule = true;
    e.adapterUncertainty = e.possibleFeedback = true;
    e.operationCount = (size_t) kMaxOps;
    const PlanRisk r = computeRisk(e, kMaxOps);
    for (size_t i = 0; i < r.entries.size(); i++) {
        CHECK((int) r.entries[i].flag < (int) gen::RiskFlag::COUNT_);
        CHECK(std::string(r.entries[i].name()) != "");
        CHECK_FALSE(r.entries[i].reason.empty());
    }
}
