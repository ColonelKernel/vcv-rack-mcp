#include <doctest.h>
#include <set>
#include <string>
#include "core/tutorial.hpp"

using namespace rackmcp;

namespace {

/** A state in which every step is satisfied; tests knock one field out. */
TutorialState finished() {
    TutorialState s;
    s.bridgeRunning = true;
    s.port = 47613;
    s.bridgeModules = 1;
    s.pumpAttached = true;
    s.activeSessions = 1;
    s.lastOp = "patch.snapshot";
    s.leaseHeld = true;
    s.leaseHolder = "rack-mcp-server";
    s.committedTransaction = true;
    s.userModules = 5;
    s.cables = 6;
    s.audioDestinationFed = true;
    s.patchSaved = true;
    s.patchHasPath = true;
    return s;
}

} // namespace

TEST_CASE("a fresh rack is at the first step") {
    TutorialState s; // every field default-false
    CHECK(currentTutorialStep(s) == 0);
    CHECK(satisfiedTutorialSteps(s) == 0);
    CHECK(std::string(TUTORIAL_STEPS[0].id) == "bridge_running");
}

TEST_CASE("a fully set-up rack is past the last step") {
    CHECK(currentTutorialStep(finished()) == TUTORIAL_STEP_COUNT);
    CHECK(satisfiedTutorialSteps(finished()) == TUTORIAL_STEP_COUNT);
}

TEST_CASE("every step is reachable as the current step") {
    // Guards against a step that can never be shown because an earlier one
    // subsumes it, which would make it dead UI rather than a checkpoint.
    std::set<int> reached;
    for (int i = 0; i < TUTORIAL_STEP_COUNT; i++) {
        TutorialState s = finished();
        switch (i) {
            case 0: s.bridgeRunning = false; break;
            case 1: s.pumpAttached = false; break;
            case 2: s.activeSessions = 0; break;
            case 3: s.lastOp.clear(); break;
            case 4: s.leaseHeld = false; break;
            case 5: s.committedTransaction = false; break;
            case 6: s.userModules = 1; break;
            case 7: s.audioDestinationFed = false; break;
            case 8: s.patchSaved = false; break;
            default: break;
        }
        CAPTURE(i);
        CAPTURE(TUTORIAL_STEPS[i].id);
        CHECK(currentTutorialStep(s) == i);
        reached.insert(currentTutorialStep(s));
    }
    CHECK((int) reached.size() == TUTORIAL_STEP_COUNT);
}

TEST_CASE("progress reports the first failure, not the count") {
    // An earlier step regressing is the thing worth showing: a lease that timed
    // out is why the next request will be refused, even though everything after
    // it still looks done.
    TutorialState s = finished();
    s.leaseHeld = false;
    CHECK(currentTutorialStep(s) == 4);
    CHECK(satisfiedTutorialSteps(s) == TUTORIAL_STEP_COUNT - 1);
}

TEST_CASE("a Bridge module without an attached pump does not satisfy its step") {
    TutorialState s = finished();
    s.pumpAttached = false;
    CHECK(currentTutorialStep(s) == 1);
    CHECK(tutorialDiagnosis(s, 1) == "a Bridge module is present but the pump has not attached yet");
}

TEST_CASE("a failing handshake is distinguished from no client at all") {
    TutorialState quiet = finished();
    quiet.activeSessions = 0;
    CHECK(currentTutorialStep(quiet) == 2);
    CHECK(tutorialDiagnosis(quiet, 2).empty());

    TutorialState rejected = quiet;
    rejected.authFailuresSinceOpen = 3;
    CHECK(currentTutorialStep(rejected) == 2);
    CHECK(tutorialDiagnosis(rejected, 2) ==
          "a client failed to authenticate 3x: its pairing secret is stale");
}

TEST_CASE("a lease held by someone else is named") {
    TutorialState s = finished();
    s.leaseHeld = false;
    s.leaseHolder = "another-host";
    CHECK(tutorialDiagnosis(s, 4) == "the lease is held by another-host");
}

TEST_CASE("a patch saved but never named is called out") {
    TutorialState s = finished();
    s.patchHasPath = false;
    CHECK(currentTutorialStep(s) == 8);
    CHECK(tutorialDiagnosis(s, 8) == "saved, but never given a filename");
}

TEST_CASE("step ids are unique, stable-looking, and every field is filled in") {
    std::set<std::string> ids;
    for (int i = 0; i < TUTORIAL_STEP_COUNT; i++) {
        const TutorialStep& step = TUTORIAL_STEPS[i];
        CAPTURE(i);
        REQUIRE(step.id != NULL);
        REQUIRE(step.title != NULL);
        REQUIRE(step.body != NULL);
        REQUIRE(step.doc != NULL);
        REQUIRE(step.satisfied != NULL);
        CHECK(ids.insert(step.id).second); // ids are persisted; duplicates corrupt resume
        CHECK(std::string(step.title).size() <= 26);
        // Bodies are rendered in a fixed panel area; an overlong one is clipped
        // rather than wrapped off the panel, which reads as a truncated sentence.
        CHECK(std::string(step.body).size() <= 200);
        CHECK(std::string(step.doc).find(".md") != std::string::npos);
    }
}

TEST_CASE("no step body reprints a command line") {
    // The division of labour with the written guide: this panel says what is
    // true and what to do in Rack; anything you type into a terminal lives in
    // the docs, where it can be per-OS and kept correct.
    for (int i = 0; i < TUTORIAL_STEP_COUNT; i++) {
        const std::string body = TUTORIAL_STEPS[i].body;
        CAPTURE(TUTORIAL_STEPS[i].id);
        // Only unambiguously command-shaped tokens: "make" is also a verb,
        // and this check caught the sentence "three modules make a patch".
        CHECK(body.find("pnpm ") == std::string::npos);
        CHECK(body.find("npm ") == std::string::npos);
        CHECK(body.find("make -") == std::string::npos);
        CHECK(body.find("cd ") == std::string::npos);
        CHECK(body.find("./") == std::string::npos);
        CHECK(body.find("$ ") == std::string::npos);
    }
}
