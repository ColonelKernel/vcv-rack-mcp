#include <doctest.h>
#include <string>
#include <vector>
#include "core/framing.hpp"

using rackmcp::FrameDecoder;
using rackmcp::encodeFrame;

static const size_t MAX = 1024 * 1024;

TEST_CASE("encode/decode round trip") {
    std::string wire;
    REQUIRE(encodeFrame("{\"kind\":\"ping\"}", MAX, wire));
    CHECK(wire.size() == 4 + 15);

    FrameDecoder d(MAX);
    REQUIRE(d.push(wire));
    std::string frame;
    REQUIRE(d.next(frame));
    CHECK(frame == "{\"kind\":\"ping\"}");
    CHECK_FALSE(d.next(frame));
    CHECK_FALSE(d.error());
}

TEST_CASE("empty frame is legal on the wire") {
    std::string wire;
    REQUIRE(encodeFrame("", MAX, wire));
    FrameDecoder d(MAX);
    REQUIRE(d.push(wire));
    std::string frame;
    REQUIRE(d.next(frame));
    CHECK(frame.empty());
}

TEST_CASE("byte-at-a-time delivery") {
    std::string wire;
    REQUIRE(encodeFrame("hello world", MAX, wire));
    FrameDecoder d(MAX);
    std::string frame;
    for (size_t i = 0; i < wire.size(); i++) {
        REQUIRE(d.push((const uint8_t*) &wire[i], 1));
        if (i + 1 < wire.size())
            CHECK_FALSE(d.next(frame));
    }
    REQUIRE(d.next(frame));
    CHECK(frame == "hello world");
}

TEST_CASE("multiple frames in one chunk") {
    std::string wire, one;
    for (int i = 0; i < 100; i++) {
        REQUIRE(encodeFrame(std::string(100, (char) ('a' + i % 26)), MAX, one));
        wire += one;
    }
    FrameDecoder d(MAX);
    REQUIRE(d.push(wire));
    std::string frame;
    int count = 0;
    while (d.next(frame)) {
        CHECK(frame.size() == 100);
        count++;
    }
    CHECK(count == 100);
    CHECK(d.buffered() == 0);
}

TEST_CASE("oversize declared length is a permanent error") {
    FrameDecoder d(MAX);
    // Header declaring 2 MiB.
    uint8_t hdr[4] = {0x00, 0x20, 0x00, 0x00};
    REQUIRE(d.push(hdr, 4));
    std::string frame;
    CHECK_FALSE(d.next(frame));
    CHECK(d.error());
    CHECK_FALSE(d.push(hdr, 4));
}

TEST_CASE("encode refuses oversize payloads") {
    std::string wire;
    CHECK_FALSE(encodeFrame(std::string(MAX + 1, 'x'), MAX, wire));
    CHECK(encodeFrame(std::string(MAX, 'x'), MAX, wire));
}

TEST_CASE("max-size frame round trips") {
    std::string payload(MAX, 'z');
    std::string wire;
    REQUIRE(encodeFrame(payload, MAX, wire));
    FrameDecoder d(MAX);
    REQUIRE(d.push(wire));
    std::string frame;
    REQUIRE(d.next(frame));
    CHECK(frame.size() == MAX);
}

TEST_CASE("flood without draining trips the memory bound") {
    FrameDecoder d(1024);
    std::string wire;
    REQUIRE(encodeFrame(std::string(1000, 'x'), 1024, wire));
    bool tripped = false;
    for (int i = 0; i < 10; i++) {
        if (!d.push(wire)) {
            tripped = true;
            break;
        }
    }
    CHECK(tripped);
    CHECK(d.error());
}

TEST_CASE("interleaved push/drain sustains indefinitely") {
    FrameDecoder d(1024);
    std::string wire;
    REQUIRE(encodeFrame(std::string(1000, 'x'), 1024, wire));
    std::string frame;
    for (int i = 0; i < 10000; i++) {
        REQUIRE(d.push(wire));
        REQUIRE(d.next(frame));
    }
    CHECK(d.buffered() == 0);
    CHECK_FALSE(d.error());
}
