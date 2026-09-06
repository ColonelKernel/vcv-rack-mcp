#include "doctest.h"

#include "core/frames.hpp"

#include <jansson.h>

#include <string>

using namespace rackmcp;

/**
 * An oversized response used to be dropped by the writer loop: encodeFrame
 * refuses a payload past the frame cap, and by then the request id is gone, so
 * nothing was sent and the caller could only time out. capResponseFrame
 * substitutes the answer while the id is still in hand. These tests pin the
 * substitution itself and the two properties that make it safe to send: the
 * result is valid JSON, and it fits inside the cap that rejected the original.
 */

static json_t* parse(const std::string& frame) {
    json_error_t err;
    return json_loads(frame.c_str(), 0, &err);
}

TEST_CASE("capResponseFrame passes a frame that fits through untouched") {
    std::string ok = buildResOk("0123456789abcdef", json_pack("{s:i}", "value", 1));
    CHECK(capResponseFrame(ok, "0123456789abcdef", "patch.snapshot", 1024 * 1024, false) == ok);
}

TEST_CASE("capResponseFrame answers an oversized frame instead of dropping it") {
    const size_t cap = 4096;
    // A real oversized payload, not a synthetic string: the substitution must
    // trigger on the encoded frame size the writer loop would have measured.
    json_t* big = json_object();
    json_t* arr = json_array();
    for (int i = 0; i < 2000; i++)
        json_array_append_new(arr, json_string("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
    json_object_set_new(big, "modules", arr);
    std::string frame = buildResOk("0123456789abcdef", big);
    REQUIRE(frame.size() > cap);

    std::string capped =
        capResponseFrame(frame, "0123456789abcdef", "patch.snapshot", cap, false);
    CHECK(capped != frame);
    CHECK(capped.size() <= cap);

    json_t* root = parse(capped);
    REQUIRE(root != NULL);
    CHECK(std::string(json_string_value(json_object_get(root, "kind"))) == "res");
    CHECK(std::string(json_string_value(json_object_get(root, "id"))) == "0123456789abcdef");
    CHECK(json_is_false(json_object_get(root, "ok")));
    json_t* err = json_object_get(root, "error");
    REQUIRE(json_is_object(err));
    CHECK(std::string(json_string_value(json_object_get(err, "code"))) == "RESULT_TOO_LARGE");
    // Retrying reproduces the same oversized result, so the caller must not.
    CHECK(json_is_false(json_object_get(err, "retrySafe")));
    CHECK(json_is_false(json_object_get(err, "mutationMayHaveOccurred")));
    // The message must name the method and both sizes, so the cause is legible
    // without correlating against a log.
    std::string message = json_string_value(json_object_get(err, "message"));
    CHECK(message.find("patch.snapshot") != std::string::npos);
    CHECK(message.find("4096") != std::string::npos);
    json_decref(root);
}

TEST_CASE("an oversized mutating result reports that the mutation may have happened") {
    // The command already ran; only its reply was too big. A caller that reads
    // this as "nothing happened" would wrongly retry a completed mutation.
    std::string frame = buildResOk("0123456789abcdef", json_pack("{s:s}", "pad", std::string(300, 'x').c_str()));
    std::string capped = capResponseFrame(frame, "0123456789abcdef", "txn.commit", 64, true);
    json_t* root = parse(capped);
    REQUIRE(root != NULL);
    CHECK(json_is_true(json_object_get(json_object_get(root, "error"), "mutationMayHaveOccurred")));
    json_decref(root);
}

TEST_CASE("capResponseFrame clamps a hostile method name so the answer still fits") {
    std::string frame(4096, 'x');
    std::string capped = capResponseFrame(frame, "0123456789abcdef", std::string(4000, 'm'), 512, false);
    CHECK(capped.size() <= 512);
    json_t* root = parse(capped);
    bool parsed = root != NULL;
    CHECK(parsed);
    if (root)
        json_decref(root);
}

#include "core/service.hpp"

/**
 * `requestLatencyEwmaMs` was a hardcoded 0 on the wire. Now that it reports a
 * real average, the arithmetic behind it is worth pinning: it runs in integer
 * microseconds on the UI thread, and unsigned subtraction is one wrong turn
 * away from wrapping to an astronomical latency.
 */

TEST_CASE("ewmaStepUs seeds on the first sample instead of climbing from zero") {
    // Seeding matters: from a 0 start, alpha=1/8 needs a dozen samples to
    // approach the truth, and the metric would understate latency the whole way.
    CHECK(ewmaStepUs(0, 4000) == 4000);
    CHECK(ewmaStepUs(0, 1) == 1);
}

TEST_CASE("ewmaStepUs moves an eighth of the way toward the sample") {
    CHECK(ewmaStepUs(1000, 1800) == 1100); // 1000 + 800/8
    CHECK(ewmaStepUs(1800, 1000) == 1700); // 1800 - 800/8
    // A steady stream of identical samples is a fixed point.
    CHECK(ewmaStepUs(1000, 1000) == 1000);
}

TEST_CASE("ewmaStepUs never wraps when the sample is below the average") {
    // The subtraction is unsigned: `prev + (sample - prev) / 8` written the
    // obvious way underflows to ~2.3e18 us here, which would surface as a
    // latency of 2.3 trillion ms.
    uint64_t v = ewmaStepUs(1000000, 1);
    CHECK(v < 1000000);
    CHECK(v == 875001); // 1000000 - 999999/8
    CHECK(ewmaStepUs(8, 0) == 7);
}

TEST_CASE("ewmaStepUs converges toward a changed steady state") {
    uint64_t v = 0;
    for (int i = 0; i < 100; i++)
        v = ewmaStepUs(v, 2000);
    CHECK(v == 2000);
    for (int i = 0; i < 200; i++)
        v = ewmaStepUs(v, 500);
    // Integer division stalls the tail one step above the target; what matters
    // is that it lands there and stays, rather than drifting.
    CHECK(v <= 507);
    CHECK(v >= 500);
}

TEST_CASE("protocol version selection picks the highest mutually supported version") {
    // Driven with synthetic ranges on purpose. With the floor and the current
    // version both 1, a test that went through the real handshake could not
    // distinguish this from an equality check: every offer one accepts, the
    // other accepts too. These ranges are the ones that will exist later.
    struct Case {
        const char* json;
        int min;
        int max;
        int expected;
    };
    const Case cases[] = {
        {"[1]", 1, 1, 1},                 // today
        {"[1, 2, 3]", 1, 3, 3},           // client and plugin fully overlap
        {"[1, 2, 3]", 2, 2, 2},           // plugin dropped v1 and has not reached v3
        {"[3, 1, 2]", 1, 3, 3},           // order of the offer does not matter
        {"[1]", 2, 3, 0},                 // client too old: no overlap
        {"[4, 5]", 1, 3, 0},              // client too new: no overlap
        {"[]", 1, 3, 0},                  // offered nothing
        {"[\"1\", null, 2]", 1, 3, 2},    // junk entries ignored, not fatal
        {"[1.5]", 1, 3, 0},               // a non-integer is not a version
    };
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); i++) {
        json_error_t err;
        json_t* offered = json_loads(cases[i].json, 0, &err);
        REQUIRE(offered != NULL);
        CAPTURE(cases[i].json);
        CAPTURE(cases[i].min);
        CAPTURE(cases[i].max);
        CHECK(selectProtocolVersion(offered, cases[i].min, cases[i].max) == cases[i].expected);
        json_decref(offered);
    }

    CHECK(selectProtocolVersion(NULL, 1, 3) == 0);
    json_t* notAnArray = json_integer(1);
    CHECK(selectProtocolVersion(notAnArray, 1, 3) == 0);
    json_decref(notAnArray);
}
