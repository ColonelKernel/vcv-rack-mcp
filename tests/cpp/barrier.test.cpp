#include <doctest.h>
#include <stdexcept>
#include <string>
#include "core/barrier.hpp"

using namespace rackmcp;

// Stands in for the frame `executeCommand` returns. A std::string, like the
// real one, so "left untouched on a throw" is observable.
static std::string kUntouched() {
    return "PREVIOUS FRAME";
}

TEST_CASE("a call that returns normally assigns its result and reports nothing") {
    std::string frame = kUntouched();
    const GuardOutcome guard = guardedCall([]() { return std::string("{\"kind\":\"res\"}"); }, frame);
    CHECK_FALSE(guard.threw);
    CHECK_FALSE(guard.nonStandard);
    CHECK(guard.detail.empty());
    CHECK(guard.message.empty());
    CHECK(frame == "{\"kind\":\"res\"}");
}

TEST_CASE("a std::exception is caught and quoted") {
    // Rack itself throws rack::Exception, and third-party plugin code throws
    // whatever it likes off std::exception.
    std::string frame = kUntouched();
    const GuardOutcome guard =
        guardedCall([]() -> std::string { throw std::runtime_error("could not open the patch"); },
                    frame);
    CHECK(guard.threw);
    CHECK_FALSE(guard.nonStandard);
    CHECK(guard.detail == "could not open the patch");
    CHECK(guard.message == "handler threw: could not open the patch");
}

TEST_CASE("a std::string is caught and quoted, because the applier throws those") {
    std::string frame = kUntouched();
    const GuardOutcome guard =
        guardedCall([]() -> std::string { throw std::string("module gone during set_parameter"); },
                    frame);
    CHECK(guard.threw);
    CHECK_FALSE(guard.nonStandard);
    CHECK(guard.detail == "module gone during set_parameter");
    CHECK(guard.message == "handler threw: module gone during set_parameter");
}

TEST_CASE("something that is neither is still caught, and says so") {
    // The clause that actually keeps Rack alive when a plugin throws an int, a
    // pointer, or its own unrelated type.
    std::string frame = kUntouched();
    const GuardOutcome guard = guardedCall([]() -> std::string { throw 7; }, frame);
    CHECK(guard.threw);
    CHECK(guard.nonStandard);
    // No what() to quote, so the message names the situation rather than
    // leaving an operator with an empty reason.
    CHECK(guard.detail == "a non-standard exception");
    CHECK(guard.message == "handler threw a non-standard exception");
}

TEST_CASE("the result is left untouched when the call throws") {
    // This is the property a caller depends on and the one most easily lost in
    // a rewrite: on a throw the pump overwrites `frame` with an INTERNAL error,
    // and it must not first read a half-built one.
    std::string frame = kUntouched();
    guardedCall([]() -> std::string { throw std::runtime_error("boom"); }, frame);
    CHECK(frame == "PREVIOUS FRAME");

    guardedCall([]() -> std::string { throw std::string("boom"); }, frame);
    CHECK(frame == "PREVIOUS FRAME");

    guardedCall([]() -> std::string { throw 7; }, frame);
    CHECK(frame == "PREVIOUS FRAME");
}

TEST_CASE("nonStandard distinguishes the two log lines, not just the message") {
    // The pump logs `%s threw: %s` in one case and a fixed line in the other,
    // so the flag has to be readable on its own -- a caller cannot infer it by
    // matching on the message text.
    std::string frame;
    CHECK_FALSE(guardedCall([]() -> std::string { throw std::string("x"); }, frame).nonStandard);
    CHECK(guardedCall([]() -> std::string { throw 7; }, frame).nonStandard);
}
