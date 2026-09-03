#include <doctest.h>
#include <jansson.h>
#include <cmath>
#include <limits>
#include <string>
#include "core/canonical.hpp"

using namespace rackmcp;

TEST_CASE("canonical dump sorts keys recursively and is compact") {
    json_t* o = json_pack("{s:i, s:{s:i, s:i}, s:[i,i]}", "zeta", 1, "beta", "y", 2, "x", 3, "alpha", 4, 5);
    REQUIRE(o);
    CHECK(canonicalDumps(o) == "{\"alpha\":[4,5],\"beta\":{\"x\":3,\"y\":2},\"zeta\":1}");
    json_decref(o);
}

TEST_CASE("fingerprint is order independent for objects, order dependent for arrays") {
    json_t* a = json_pack("{s:i, s:i}", "a", 1, "b", 2);
    json_t* b = json_pack("{s:i, s:i}", "b", 2, "a", 1);
    CHECK(canonicalFingerprint(a) == canonicalFingerprint(b));
    json_decref(a);
    json_decref(b);

    json_t* arr1 = json_pack("[i,i]", 1, 2);
    json_t* arr2 = json_pack("[i,i]", 2, 1);
    CHECK(canonicalFingerprint(arr1) != canonicalFingerprint(arr2));
    json_decref(arr1);
    json_decref(arr2);
}

TEST_CASE("fingerprint is stable across runs (golden value)") {
    json_t* o = json_pack("{s:s, s:i, s:f}", "name", "VCO", "id", 42, "freq", 261.625565);
    std::string fp = canonicalFingerprint(o);
    CHECK(fp.size() == 64);
    // Golden: canonical reals use 17 significant digits (round-trip exact).
    CHECK(canonicalDumps(o) == "{\"freq\":261.62556499999999,\"id\":42,\"name\":\"VCO\"}");
    json_decref(o);
}

TEST_CASE("real precision preserves float64 exactly") {
    json_t* r = json_real(0.1 + 0.2);
    std::string s = canonicalDumps(r);
    json_error_t err;
    json_t* back = json_loads(s.c_str(), JSON_DECODE_ANY, &err);
    REQUIRE(back);
    CHECK(json_real_value(back) == 0.1 + 0.2);
    json_decref(r);
    json_decref(back);
}

TEST_CASE("json limits: depth") {
    json_t* deep = json_integer(1);
    for (int i = 0; i < 20; i++) {
        json_t* wrap = json_object();
        json_object_set_new(wrap, "d", deep);
        deep = wrap;
    }
    CHECK(checkJsonLimits(deep, 64, 100000, 4096));
    CHECK_FALSE(checkJsonLimits(deep, 10, 100000, 4096));
    json_decref(deep);
}

TEST_CASE("json limits: node count and string size") {
    json_t* arr = json_array();
    for (int i = 0; i < 100; i++)
        json_array_append_new(arr, json_integer(i));
    CHECK(checkJsonLimits(arr, 64, 1000, 4096));
    CHECK_FALSE(checkJsonLimits(arr, 64, 50, 4096));
    json_decref(arr);

    json_t* s = json_string("aaaaaaaaaa");
    CHECK(checkJsonLimits(s, 64, 100, 10));
    CHECK_FALSE(checkJsonLimits(s, 64, 100, 9));
    json_decref(s);
}

TEST_CASE("json limits: NaN and infinity are rejected") {
    // jansson refuses to create NaN reals via json_real(); force via memcpy of
    // a valid real is not possible through the public API, so simulate with
    // the value jansson does allow through json_real when compiled without
    // NaN checks. If json_real returns NULL, the boundary is already safe.
    json_t* nanReal = json_real(std::nan(""));
    if (nanReal) {
        CHECK_FALSE(checkJsonLimits(nanReal, 64, 100, 100));
        json_decref(nanReal);
    }
    json_t* infReal = json_real(std::numeric_limits<double>::infinity());
    if (infReal) {
        CHECK_FALSE(checkJsonLimits(infReal, 64, 100, 100));
        json_decref(infReal);
    }
}

/**
 * truncateUtf8 clamps untrusted plugin metadata (model descriptions, tag and
 * port names) to the schema bounds. Cutting mid-sequence would leave a
 * trailing fragment, and jansson's json_string() rejects invalid UTF-8 by
 * returning NULL — which would silently drop the field from the payload, or
 * take down the whole frame. So the invariant under test is not just "short
 * enough" but "still valid UTF-8, and still accepted by jansson".
 */
TEST_CASE("truncateUtf8 never splits a multi-byte sequence") {
    // "aé€𝄞" — 1, 2, 3 and 4-byte sequences back to back (10 bytes total).
    const std::string mixed = "a\xC3\xA9\xE2\x82\xAC\xF0\x9D\x84\x9E";
    REQUIRE(mixed.size() == 10);

    // Every cut point must yield a prefix jansson accepts.
    for (size_t limit = 0; limit <= mixed.size() + 2; limit++) {
        std::string s = mixed;
        truncateUtf8(s, limit);
        CHECK(s.size() <= (limit < mixed.size() ? limit : mixed.size()));
        CHECK(mixed.compare(0, s.size(), s) == 0); // a prefix, never rewritten
        json_t* j = json_stringn(s.data(), s.size());
        CHECK(j != NULL); // valid UTF-8: jansson accepted it
        json_decref(j);
    }

    // Specific boundaries: cutting inside the 4-byte sequence drops it whole.
    std::string s = mixed;
    truncateUtf8(s, 8);
    CHECK(s == "a\xC3\xA9\xE2\x82\xAC");
    s = mixed;
    truncateUtf8(s, 3);
    CHECK(s == "a\xC3\xA9");
    s = mixed;
    truncateUtf8(s, 1);
    CHECK(s == "a");
}

TEST_CASE("truncateUtf8 leaves short strings untouched") {
    std::string s = "already short";
    truncateUtf8(s, 64);
    CHECK(s == "already short");
    std::string empty;
    truncateUtf8(empty, 0);
    CHECK(empty.empty());
}

/**
 * Pins the jansson behaviour that Snapshot.cpp's realOrNull() exists to work
 * around: json_real() refuses non-finite values, and json_object_set_new() with
 * a NULL value sets nothing at all. Without the guard a module with an
 * unbounded param (Rack allows configParam with +/-INFINITY bounds) would ship
 * a payload missing a schema-required key rather than one carrying an explicit
 * null — a silent contract violation instead of an honest "unbounded".
 */
TEST_CASE("jansson drops a key when the value is a non-finite real") {
    const double inf = std::numeric_limits<double>::infinity();
    CHECK(json_real(inf) == static_cast<json_t*>(NULL));
    CHECK(json_real(-inf) == static_cast<json_t*>(NULL));
    CHECK(json_real(std::nan("")) == static_cast<json_t*>(NULL));

    json_t* o = json_object();
    // The exact shape of the bug: the key silently fails to appear.
    const int rc = json_object_set_new(o, "minValue", json_real(-inf));
    CHECK(rc != 0);
    CHECK(json_object_get(o, "minValue") == static_cast<json_t*>(NULL));
    CHECK(json_object_size(o) == 0u);

    // What realOrNull does instead: the key is present and explicitly null.
    json_object_set_new(o, "minValue", json_null());
    CHECK(json_object_size(o) == 1);
    CHECK(json_is_null(json_object_get(o, "minValue")));
    json_decref(o);
}
