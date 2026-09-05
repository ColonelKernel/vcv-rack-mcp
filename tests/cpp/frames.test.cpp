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
