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

// ---------------------------------------------------------------------------
// Id parsing and reference resolution
// ---------------------------------------------------------------------------

static int64_t parsed(const std::string& text) {
    int64_t out = -999;
    return parseDecimalId(text, out) ? out : -1;
}

TEST_CASE("a decimal id is exactly what the schema says it is") {
    CHECK(parsed("0") == 0);
    CHECK(parsed("42") == 42);
    CHECK(parsed("4360803558046751") == 4360803558046751LL);
    // 19 digits, the schema's maximum, and inside int64.
    CHECK(parsed("9223372036854775807") == 9223372036854775807LL);
}

TEST_CASE("an empty moduleId is not module zero") {
    // This is the one that mattered. strtoll("") returns 0 and leaves endp on
    // the terminator, so the old `*endp == '\0' && id >= 0` test accepted it
    // and every operation carrying {"moduleId": ""} silently acted on module
    // 0 -- a real module on most racks, and not the one anybody named.
    int64_t out = -999;
    CHECK_FALSE(parseDecimalId("", out));
    CHECK(out == -999);  // and it does not write through on failure
}

TEST_CASE("the permissive spellings strtoll used to accept are refused") {
    CHECK(parsed(" 42") == -1);   // leading whitespace
    CHECK(parsed("42 ") == -1);   // trailing whitespace
    CHECK(parsed("+5") == -1);    // explicit sign
    CHECK(parsed("-1") == -1);    // negative
    CHECK(parsed("042") == -1);   // leading zero
    CHECK(parsed("00") == -1);
    CHECK(parsed("42x") == -1);   // trailing garbage
    CHECK(parsed("0x2a") == -1);  // hex
    CHECK(parsed("1e5") == -1);   // exponent
    CHECK(parsed("4 2") == -1);
    CHECK(parsed("\t7") == -1);
}

TEST_CASE("an id too large for int64 is refused, not clamped") {
    // strtoll saturates at INT64_MAX and reports success, so an absurd id
    // became a plausible one. The schema's regex admits 19 digits and cannot
    // express the numeric bound, so this is the only place it can be caught.
    CHECK(parsed("9223372036854775808") == -1);
    CHECK(parsed("9999999999999999999") == -1);
    // 20 digits fails the shape before arithmetic is reached.
    CHECK(parsed("12345678901234567890") == -1);
}

TEST_CASE("a module reference resolves by id") {
    std::map<std::string, int64_t> aliases;
    json_t* ref = json_pack("{s:s}", "moduleId", "77");
    const ModuleRef r = resolveModuleRef(ref, aliases);
    CHECK(r.ok);
    CHECK_FALSE(r.isAlias);
    CHECK(r.moduleId == 77);
    json_decref(ref);
}

TEST_CASE("a module reference resolves by alias declared earlier in the plan") {
    std::map<std::string, int64_t> aliases;
    aliases["vco"] = -1000;  // provisional synthetic id
    json_t* ref = json_pack("{s:s}", "alias", "vco");
    const ModuleRef r = resolveModuleRef(ref, aliases);
    CHECK(r.ok);
    CHECK(r.isAlias);
    CHECK(r.alias == "vco");
    CHECK(r.moduleId == -1000);
    json_decref(ref);
}

TEST_CASE("an unknown alias is reported as an alias, not as a bad reference") {
    // The caller distinguishes these: an unknown alias means the plan referred
    // to a module it never created, and the error should say which name.
    std::map<std::string, int64_t> aliases;
    json_t* ref = json_pack("{s:s}", "alias", "nope");
    const ModuleRef r = resolveModuleRef(ref, aliases);
    CHECK_FALSE(r.ok);
    CHECK(r.isAlias);
    CHECK(r.alias == "nope");
    json_decref(ref);
}

TEST_CASE("a malformed moduleId does not fall through to the alias") {
    // A ref carrying both keys is not legal input. Reading the alias after
    // rejecting the id would let a malformed reference act on a module the
    // caller never named.
    std::map<std::string, int64_t> aliases;
    aliases["vco"] = 5;
    json_t* ref = json_pack("{s:s, s:s}", "moduleId", "", "alias", "vco");
    const ModuleRef r = resolveModuleRef(ref, aliases);
    CHECK_FALSE(r.ok);
    CHECK_FALSE(r.isAlias);
    CHECK(r.moduleId == -1);
    json_decref(ref);
}

TEST_CASE("moduleId wins when both keys are present and both are valid") {
    std::map<std::string, int64_t> aliases;
    aliases["vco"] = 5;
    json_t* ref = json_pack("{s:s, s:s}", "moduleId", "9", "alias", "vco");
    const ModuleRef r = resolveModuleRef(ref, aliases);
    CHECK(r.ok);
    CHECK(r.moduleId == 9);
    CHECK_FALSE(r.isAlias);
    json_decref(ref);
}

TEST_CASE("a reference that is not an object, or names neither key, resolves to nothing") {
    std::map<std::string, int64_t> aliases;
    CHECK_FALSE(resolveModuleRef(NULL, aliases).ok);
    json_t* arr = json_array();
    CHECK_FALSE(resolveModuleRef(arr, aliases).ok);
    json_decref(arr);
    json_t* empty = json_object();
    CHECK_FALSE(resolveModuleRef(empty, aliases).ok);
    json_decref(empty);
    // A numeric moduleId is not a string and is not accepted: ids cross this
    // boundary as decimal strings precisely because they do not fit a double.
    json_t* numeric = json_pack("{s:i}", "moduleId", 42);
    CHECK_FALSE(resolveModuleRef(numeric, aliases).ok);
    json_decref(numeric);
}

// ---------------------------------------------------------------------------
// Cable accounting
// ---------------------------------------------------------------------------

/** vco:0 -> vcf:0, vcf:0 -> vca:1, adsr:0 -> vca:0 */
static std::vector<PlanCable> patch() {
    std::vector<PlanCable> c;
    c.push_back(PlanCable::connected(100, 1, 0, 2, 0));
    c.push_back(PlanCable::connected(101, 2, 0, 3, 1));
    c.push_back(PlanCable::connected(102, 4, 0, 3, 0));
    return c;
}

TEST_CASE("cables on a module count both ends") {
    const std::vector<int64_t> none;
    CHECK(cablesOnModule(patch(), none, 2) == std::vector<int64_t>({100, 101}));
    CHECK(cablesOnModule(patch(), none, 1) == std::vector<int64_t>({100}));
    CHECK(cablesOnModule(patch(), none, 3) == std::vector<int64_t>({101, 102}));
    CHECK(cablesOnModule(patch(), none, 99).empty());
}

TEST_CASE("a cable an earlier operation removed is no longer attached") {
    // Without this the plan double-counts: a disconnect followed by a module
    // removal reports the same cable twice and the risk summary overstates.
    std::vector<int64_t> removed;
    removed.push_back(100);
    CHECK(cablesOnModule(patch(), removed, 2) == std::vector<int64_t>({101}));
    removed.push_back(101);
    CHECK(cablesOnModule(patch(), removed, 2).empty());
}

TEST_CASE("cables on a port distinguish input from output") {
    const std::vector<int64_t> none;
    // Module 2 port 0 is an input on cable 100 and an output on cable 101.
    CHECK(cablesOnPort(patch(), none, 2, "input", 0) == std::vector<int64_t>({100}));
    CHECK(cablesOnPort(patch(), none, 2, "output", 0) == std::vector<int64_t>({101}));
    CHECK(cablesOnPort(patch(), none, 3, "input", 1) == std::vector<int64_t>({101}));
    CHECK(cablesOnPort(patch(), none, 3, "input", 0) == std::vector<int64_t>({102}));
    CHECK(cablesOnPort(patch(), none, 3, "input", 7).empty());
    // An unrecognised port type matches nothing rather than everything.
    CHECK(cablesOnPort(patch(), none, 2, "sideways", 0).empty());
}

TEST_CASE("a detached cable end is not a connection") {
    // The engine can hold a cable with an end unattached, and hasOutput/hasInput
    // are what say so. The id beside a cleared flag must never be read: a
    // version testing the id alone passes as long as the unset id happens to be
    // the -1 sentinel, and starts reporting phantom connections the moment
    // anything leaves a stale value there. So the flag is set false here with a
    // perfectly plausible id beside it -- which is the state the check exists
    // to survive.
    std::vector<PlanCable> cables;
    PlanCable dangling;
    dangling.id = 200;
    dangling.hasInput = true;
    dangling.inputModuleId = 3;
    dangling.inputId = 0;
    dangling.hasOutput = false;
    dangling.outputModuleId = 7;  // stale, and must be ignored
    dangling.outputId = 0;
    cables.push_back(dangling);

    const std::vector<int64_t> none;
    CHECK(cablesOnModule(cables, none, 3) == std::vector<int64_t>({200}));
    CHECK(cablesOnModule(cables, none, 7).empty());
    CHECK(cablesOnPort(cables, none, 7, "output", 0).empty());
    CHECK(cablesOnPort(cables, none, 3, "input", 0) == std::vector<int64_t>({200}));
}

TEST_CASE("cable order is preserved, because a policy depends on it") {
    // disconnect_port "top" takes the LAST match, so the order this returns is
    // part of the contract rather than an implementation detail.
    std::vector<PlanCable> stacked;
    stacked.push_back(PlanCable::connected(10, 1, 0, 9, 0));
    stacked.push_back(PlanCable::connected(11, 2, 0, 9, 0));
    stacked.push_back(PlanCable::connected(12, 3, 0, 9, 0));
    const std::vector<int64_t> none;
    CHECK(cablesOnPort(stacked, none, 9, "input", 0) == std::vector<int64_t>({10, 11, 12}));
}
