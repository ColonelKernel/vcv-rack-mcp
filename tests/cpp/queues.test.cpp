#include <doctest.h>
#include <atomic>
#include <chrono>
#include <string>
#include <thread>
#include <vector>
#include "core/queues.hpp"
#include "core/telemetry.hpp"

using namespace rackmcp;

TEST_CASE("bounded queue basic push/pop") {
    BoundedQueue<int> q(4);
    CHECK(q.tryPush(1));
    CHECK(q.tryPush(2));
    int v = 0;
    CHECK(q.tryPop(v));
    CHECK(v == 1);
    CHECK(q.tryPop(v));
    CHECK(v == 2);
    CHECK_FALSE(q.tryPop(v));
}

TEST_CASE("bounded queue saturation") {
    BoundedQueue<int> q(3);
    CHECK(q.tryPush(1));
    CHECK(q.tryPush(2));
    CHECK(q.tryPush(3));
    CHECK_FALSE(q.tryPush(4));
    int v;
    CHECK(q.tryPop(v));
    CHECK(q.tryPush(4));
    CHECK(q.maxDepth() == 3);
}

TEST_CASE("close wakes blocked poppers and rejects pushes") {
    BoundedQueue<std::string> q(8);
    std::atomic<bool> woke{false};
    std::thread waiter([&] {
        std::string s;
        bool got = q.popWait(s, 5000);
        woke = true;
        CHECK_FALSE(got);
    });
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
    q.close();
    waiter.join();
    CHECK(woke);
    CHECK_FALSE(q.tryPush("nope"));
}

TEST_CASE("close drains remaining items") {
    BoundedQueue<int> q(8);
    q.tryPush(7);
    q.close();
    int v = 0;
    CHECK(q.tryPop(v));
    CHECK(v == 7);
    CHECK_FALSE(q.tryPop(v));
}

TEST_CASE("mpmc stress: all items delivered exactly once") {
    BoundedQueue<int> q(64);
    const int PRODUCERS = 4, ITEMS = 5000;
    std::atomic<long> sum{0};
    std::atomic<int> received{0};
    std::vector<std::thread> threads;
    for (int p = 0; p < PRODUCERS; p++) {
        threads.emplace_back([&, p] {
            for (int i = 0; i < ITEMS; i++) {
                int value = p * ITEMS + i;
                while (!q.tryPush(value))
                    std::this_thread::yield();
            }
        });
    }
    for (int c = 0; c < 2; c++) {
        threads.emplace_back([&] {
            int v;
            while (received.load() < PRODUCERS * ITEMS) {
                if (q.popWait(v, 10)) {
                    sum += v;
                    received++;
                }
            }
        });
    }
    for (auto& t : threads)
        t.join();
    long expected = 0;
    for (int p = 0; p < PRODUCERS; p++)
        for (int i = 0; i < ITEMS; i++)
            expected += p * ITEMS + i;
    CHECK(received.load() == PRODUCERS * ITEMS);
    CHECK(sum.load() == expected);
}

TEST_CASE("telemetry snapshot buffer: unpublished reads fail") {
    TelemetrySnapshotBuffer<ProbeWindowSnapshot> buf;
    ProbeWindowSnapshot out;
    CHECK_FALSE(buf.read(out));
}

TEST_CASE("telemetry snapshot buffer: publish then read") {
    TelemetrySnapshotBuffer<ProbeWindowSnapshot> buf;
    ProbeWindowSnapshot in = {};
    in.sequence = 42;
    in.windowFrames = 2205;
    in.sampleRate = 44100.f;
    in.channelCount = 1;
    in.channels[0].rms = 5.f;
    buf.publish(in);
    ProbeWindowSnapshot out = {};
    REQUIRE(buf.read(out));
    CHECK(out.sequence == 42);
    CHECK(out.windowFrames == 2205);
    CHECK(out.channels[0].rms == 5.f);
    CHECK(buf.sequence() == 1);
}

TEST_CASE("telemetry snapshot buffer: concurrent stress never tears") {
    // Snapshot with an internal invariant: all slots hold the same value.
    struct Consistent {
        uint32_t values[64];
    };
    TelemetrySnapshotBuffer<Consistent> buf;
    std::atomic<bool> stop{false};
    std::thread writer([&] {
        Consistent c;
        uint32_t n = 0;
        while (!stop.load(std::memory_order_relaxed)) {
            n++;
            for (int i = 0; i < 64; i++)
                c.values[i] = n;
            buf.publish(c);
        }
    });
    // Wait for the first publish before counting anything.
    //
    // read() returns false immediately while the sequence is still 0, so a
    // reader that starts before the writer's first publish burns its whole
    // budget in about a millisecond without ever seeing data, and
    // `validated > 0` then fails for reasons that have nothing to do with the
    // buffer. Starting a thread on a loaded machine takes longer than that,
    // which is how this passed everywhere and failed on a CI runner. The
    // writer keeps spinning without pause: a read that overlaps a publish is
    // the only way to observe tearing, so slowing it down would cost the test
    // the very thing it exists to catch.
    std::chrono::steady_clock::time_point deadline =
        std::chrono::steady_clock::now() + std::chrono::seconds(10);
    while (buf.sequence() == 0 && std::chrono::steady_clock::now() < deadline)
        std::this_thread::yield();
    REQUIRE(buf.sequence() > 0);

    int validated = 0;
    Consistent out;
    for (int i = 0; i < 200000; i++) {
        if (buf.read(out)) {
            for (int k = 1; k < 64; k++)
                REQUIRE(out.values[k] == out.values[0]);
            validated++;
        }
    }
    stop = true;
    writer.join();
    CHECK(validated > 0);
}
