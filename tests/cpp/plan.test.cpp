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

// ---------------------------------------------------------------------------
// WorldModule predicates
//
// These replace three hand-written copies of the same slug comparisons in
// Transaction.cpp, none of which had a test. They decide `touchesAudio` (a
// risk flag the client is shown) and the last-bridge refusal (the rule that
// stops a transaction severing the channel it arrived on).
// ---------------------------------------------------------------------------

TEST_CASE("isAudioModule matches every Core audio interface by prefix") {
    // Core ships Audio-2, Audio-8 and Audio-16; the live code has always used a
    // prefix match, so a new Audio-N is covered without an edit.
    CHECK(isAudioModule(WorldModule(1, "Core", "Audio-2")));
    CHECK(isAudioModule(WorldModule(2, "Core", "Audio-8")));
    CHECK(isAudioModule(WorldModule(3, "Core", "Audio-16")));
    CHECK(isAudioModule(WorldModule(4, "Core", "Audio")));
}

TEST_CASE("isAudioModule is anchored, so Audio elsewhere in the slug misses") {
    // rfind(s, 0) is a prefix test, not a substring search. If this were a
    // substring search, "MIDIAudio" would raise the audio risk flag on a module
    // that touches no interface.
    CHECK_FALSE(isAudioModule(WorldModule(1, "Core", "MIDIAudio")));
    CHECK_FALSE(isAudioModule(WorldModule(2, "Core", "audio-2")));
    CHECK_FALSE(isAudioModule(WorldModule(3, "Fundamental", "Audio-2")));
    CHECK_FALSE(isAudioModule(WorldModule(4, "CoreX", "Audio-2")));
}

TEST_CASE("a module with no model is neither audio nor bridge") {
    // The live code guards `m->model && m->model->plugin` before comparing.
    // Empty slugs are how that guard survives the move to plain data: an empty
    // modelSlug must not prefix-match "Audio", and rfind on an empty string
    // returns npos rather than 0.
    WorldModule none;
    CHECK_FALSE(isAudioModule(none));
    CHECK_FALSE(isBridgeModule(none));
    CHECK_FALSE(isAudioModule(WorldModule(1, "Core", "")));
    CHECK_FALSE(isBridgeModule(WorldModule(2, "RackMCP", "")));
}

TEST_CASE("isBridgeModule is exact, not a prefix like the audio test") {
    // The two predicates deliberately differ. RackMCP also ships Probe, Chat
    // and Tutorial modules, and only Bridge carries the control channel -- a
    // prefix match on "Bridge" would still be wrong if a Bridge2 ever shipped.
    CHECK(isBridgeModule(WorldModule(1, "RackMCP", "Bridge")));
    CHECK_FALSE(isBridgeModule(WorldModule(2, "RackMCP", "BridgeX")));
    CHECK_FALSE(isBridgeModule(WorldModule(3, "RackMCP", "Probe")));
    CHECK_FALSE(isBridgeModule(WorldModule(4, "Other", "Bridge")));
}

// ---------------------------------------------------------------------------
// The last-Bridge refusal
//
// This is the guard that stops a transaction severing the control channel the
// request arrived on. It counted Bridges LIVE IN THE ENGINE, which during a
// preview is the patch as it was before the plan -- so it could not see a
// Bridge an earlier operation in the same plan had already removed.
// ---------------------------------------------------------------------------

static std::vector<WorldModule> twoBridges() {
    std::vector<WorldModule> w;
    w.push_back(WorldModule(1, "Fundamental", "VCO"));
    w.push_back(WorldModule(7, "RackMCP", "Bridge"));
    w.push_back(WorldModule(9, "RackMCP", "Bridge"));
    return w;
}

TEST_CASE("with one Bridge and nothing removed, it is the last one") {
    std::vector<WorldModule> w;
    w.push_back(WorldModule(7, "RackMCP", "Bridge"));
    std::vector<int64_t> removed;
    CHECK(remainingBridgeCount(w, removed) == 1);
}

TEST_CASE("a two-operation plan cannot remove every Bridge") {
    // The bug, stated as a test. Removing Bridge 7 leaves one Bridge, so the
    // first operation is allowed; the second must then see ONE remaining and be
    // refused. Counting the live engine returns 2 both times and permits both.
    std::vector<WorldModule> w = twoBridges();
    std::vector<int64_t> removed;
    CHECK(remainingBridgeCount(w, removed) == 2); // first removal: allowed
    removed.push_back(7);
    CHECK(remainingBridgeCount(w, removed) == 1); // second: this is the last
}

TEST_CASE("removing a non-Bridge does not change the Bridge count") {
    std::vector<WorldModule> w = twoBridges();
    std::vector<int64_t> removed;
    removed.push_back(1); // the VCO
    CHECK(remainingBridgeCount(w, removed) == 2);
}

TEST_CASE("an id removed twice is not counted down twice") {
    // st.removeCable dedupes, but st.removedModules is a plain push_back, so a
    // plan naming the same module in two remove_module operations puts the id
    // in twice. That must not make a second Bridge disappear.
    std::vector<WorldModule> w = twoBridges();
    std::vector<int64_t> removed;
    removed.push_back(7);
    removed.push_back(7);
    CHECK(remainingBridgeCount(w, removed) == 1);
}

TEST_CASE("a removal naming an id no module has changes nothing") {
    std::vector<WorldModule> w = twoBridges();
    std::vector<int64_t> removed;
    removed.push_back(-1000); // a transaction alias' synthetic id
    removed.push_back(4242);
    CHECK(remainingBridgeCount(w, removed) == 2);
}

TEST_CASE("no Bridges at all counts zero, not one") {
    // <= 1 is the refusal, so zero must be reachable: a patch with no Bridge
    // cannot be reached through the bridge, but the arithmetic should still be
    // honest rather than clamped.
    std::vector<WorldModule> w;
    w.push_back(WorldModule(1, "Fundamental", "VCO"));
    std::vector<int64_t> removed;
    CHECK(remainingBridgeCount(w, removed) == 0);
}

#if RACKMCP_HAVE_JANSSON
// ---------------------------------------------------------------------------
// checkOperationFields
//
// gen::OPERATION_SPECS has existed since the generator was written and had no
// consumer. Meanwhile the plugin read operation fields through helpers that
// substitute a default for anything unexpected, several of them pointing in
// the destructive direction.
// ---------------------------------------------------------------------------

/** Parses a literal, CHECKs it parsed, and hands it over. Caller decrefs. */
static json_t* op(const char* text) {
    json_error_t e;
    json_t* j = json_loads(text, 0, &e);
    REQUIRE(j != NULL);
    return j;
}

TEST_CASE("a well-formed operation passes") {
    json_t* j = op("{\"op\":\"set_bypass\",\"module\":{\"moduleId\":\"7\"},\"bypassed\":false}");
    CHECK(checkOperationFields(j) == "");
    json_decref(j);
}

TEST_CASE("set_bypass with a string where a boolean is declared is refused") {
    // The defect this closes: jbool returns its default for a non-boolean, and
    // applyBypass's default is `true`, so the string "false" bypassed the
    // module -- the destructive direction -- while reporting success.
    json_t* j = op("{\"op\":\"set_bypass\",\"module\":{\"moduleId\":\"7\"},\"bypassed\":\"false\"}");
    const std::string err = checkOperationFields(j);
    CHECK(err.find("bypassed") != std::string::npos);
    CHECK(err.find("boolean") != std::string::npos);
    CHECK(err.find("string") != std::string::npos);
    json_decref(j);
}

TEST_CASE("the same field omitted entirely is refused too") {
    // jbool cannot tell "absent" from "not a boolean"; both took the default.
    json_t* j = op("{\"op\":\"set_bypass\",\"module\":{\"moduleId\":\"7\"}}");
    const std::string err = checkOperationFields(j);
    CHECK(err.find("missing required field") != std::string::npos);
    CHECK(err.find("bypassed") != std::string::npos);
    json_decref(j);
}

TEST_CASE("null is not a boolean, an integer, an object or a string") {
    // json_is_* are all false for a JSON null, which is what makes the single
    // presence-and-type check cover `"value": null` shaped inputs.
    json_t* j = op("{\"op\":\"set_bypass\",\"module\":{\"moduleId\":\"7\"},\"bypassed\":null}");
    CHECK(checkOperationFields(j).find("bypassed") != std::string::npos);
    json_decref(j);
    j = op("{\"op\":\"set_parameter\",\"module\":null,\"paramId\":0}");
    CHECK(checkOperationFields(j).find("module") != std::string::npos);
    json_decref(j);
}

TEST_CASE("0 and 1 are not booleans") {
    // The C habit. jansson types them JSON_INTEGER, and jbool would have
    // returned its default for both.
    json_t* j = op("{\"op\":\"set_bypass\",\"module\":{\"moduleId\":\"7\"},\"bypassed\":0}");
    CHECK(checkOperationFields(j) != "");
    json_decref(j);
    j = op("{\"op\":\"set_bypass\",\"module\":{\"moduleId\":\"7\"},\"bypassed\":1}");
    CHECK(checkOperationFields(j) != "");
    json_decref(j);
}

TEST_CASE("a declared integer refuses a real, a string and a boolean") {
    // paramId reaches an array index. json_integer_value returns 0 for every
    // one of these, which is a real parameter on every module.
    CHECK(checkOperationFields(op("{\"op\":\"set_parameter\",\"module\":{},\"paramId\":1.5}")) != "");
    CHECK(checkOperationFields(op("{\"op\":\"set_parameter\",\"module\":{},\"paramId\":\"1\"}")) != "");
    CHECK(checkOperationFields(op("{\"op\":\"set_parameter\",\"module\":{},\"paramId\":true}")) != "");
    CHECK(checkOperationFields(op("{\"op\":\"set_parameter\",\"module\":{},\"paramId\":0}")) == "");
}

TEST_CASE("an unrecognised op is left for the caller to reject") {
    // Reporting it here would replace the UNSUPPORTED_OPERATION the caller
    // should get with a message about fields.
    json_t* j = op("{\"op\":\"teleport_module\"}");
    CHECK(checkOperationFields(j) == "");
    json_decref(j);
}

TEST_CASE("a missing or non-string op is reported, not dereferenced") {
    CHECK(checkOperationFields(op("{}")) != "");
    CHECK(checkOperationFields(op("{\"op\":7}")) != "");
    CHECK(checkOperationFields(op("[]")) != "");
    CHECK(checkOperationFields(NULL) != "");
}

TEST_CASE("every operation the schema declares is checkable") {
    // Guards against the table and the plugin drifting apart: if a new
    // operation ships with no required fields at all, that is a fact worth
    // seeing rather than a silently empty check.
    CHECK(gen::OPERATION_SPEC_COUNT > 0);
    for (size_t i = 0; i < gen::OPERATION_SPEC_COUNT; i++) {
        CHECK(gen::OPERATION_SPECS[i].op != NULL);
        // Every declared field carries a type; a null type would make
        // typeMatches accept anything and the check vacuous.
        for (size_t f = 0; f < gen::OPERATION_SPECS[i].fieldCount; f++)
            CHECK(gen::OPERATION_SPECS[i].fields[f].jsonType != NULL);
    }
}
#endif

#if RACKMCP_HAVE_JANSSON
TEST_CASE("an unrecognised policy string is refused, not defaulted") {
    // Each of these reaches a jstr(op, key, <default>) in the plugin, and every
    // one of those defaults is the destructive choice: remove_attached takes
    // the cables, replace_all deletes the existing one.
    const std::string cable = checkOperationFields(
        op("{\"op\":\"remove_module\",\"module\":{},\"cablePolicy\":\"banana\"}"));
    CHECK(cable.find("cablePolicy") != std::string::npos);
    CHECK(cable.find("remove_attached") != std::string::npos);   // names the options
    CHECK(cable.find("fail_if_connected") != std::string::npos);
    CHECK(cable.find("banana") != std::string::npos);            // and what was sent

    CHECK(checkOperationFields(op(
              "{\"op\":\"connect\",\"output\":{},\"input\":{},\"inputPolicy\":\"REPLACE_ALL\"}")) != "");
    CHECK(checkOperationFields(op(
              "{\"op\":\"disconnect_port\",\"port\":{},\"policy\":\"\"}")) != "");
    CHECK(checkOperationFields(op(
              "{\"op\":\"move_module\",\"module\":{},\"position\":{},\"collision\":\"squeeze \"}")) != "");
}

TEST_CASE("every value the schema declares is still accepted") {
    // The other half: a membership check that rejected a legal value would
    // break the shipped server, which sends exactly these strings.
    CHECK(checkOperationFields(op(
              "{\"op\":\"remove_module\",\"module\":{},\"cablePolicy\":\"remove_attached\"}")) == "");
    CHECK(checkOperationFields(op(
              "{\"op\":\"remove_module\",\"module\":{},\"cablePolicy\":\"fail_if_connected\"}")) == "");
    for (size_t i = 0; i < gen::OPERATION_SPEC_COUNT; i++) {
        const gen::OperationSpec& spec = gen::OPERATION_SPECS[i];
        for (size_t f = 0; f < spec.fieldCount; f++) {
            if (!spec.fields[f].allowed)
                continue;
            // An enum with no members would make the membership check refuse
            // every value, including the legal ones.
            CHECK(spec.fields[f].allowed[0] != NULL);
            CHECK(std::string(spec.fields[f].jsonType) == "string");
        }
    }
}

TEST_CASE("at least one operation actually carries an enum") {
    // Without this the two cases above could both pass on a table where the
    // generator silently stopped emitting `allowed` at all.
    size_t withEnum = 0;
    for (size_t i = 0; i < gen::OPERATION_SPEC_COUNT; i++)
        for (size_t f = 0; f < gen::OPERATION_SPECS[i].fieldCount; f++)
            if (gen::OPERATION_SPECS[i].fields[f].allowed)
                withEnum++;
    CHECK(withEnum >= 4); // cablePolicy, collision, inputPolicy, policy
}
#endif
