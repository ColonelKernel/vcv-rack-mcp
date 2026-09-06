// Proof that the probe's audio-thread path allocates nothing.
//
// ProbeModule::process runs on Rack's DSP thread, where a single malloc can
// take a lock held by another thread and produce an audible dropout. The code
// says "no allocation, locks, IO, or JSON here" and core/queues.hpp says
// publish() is "wait-free and allocation-free (DSP side)". Those were comments.
//
// This replaces global operator new for the whole test binary and counts calls
// while armed. Everything on the real audio path is Rack-free -- accumulate,
// finalizeChannel, TelemetrySnapshotBuffer::publish -- so the loop below is the
// same arithmetic process() performs, minus the Rack port reads.
//
// Deliberately NOT covered: BoundedQueue, which uses std::deque and does
// allocate. That is correct; it is the command queue, not the DSP path. Adding
// it here would be asserting something false about it.
#include <doctest.h>

#include <atomic>
#include <cstddef>
#include <cstdlib>
#include <new>
#include <vector>

#include "core/queues.hpp"
#include "core/telemetry.hpp"

using namespace rackmcp;

namespace {
std::atomic<long> g_allocations(0);
std::atomic<bool> g_armed(false);
}  // namespace

// Replacing the global allocator affects this whole executable. Counting is
// conditional so doctest's own allocations are ignored; the allocation itself
// always succeeds, so an armed region that does allocate is reported rather
// than crashed.
void* operator new(std::size_t size) {
    if (g_armed.load(std::memory_order_relaxed))
        g_allocations.fetch_add(1, std::memory_order_relaxed);
    void* p = std::malloc(size ? size : 1);
    if (!p)
        throw std::bad_alloc();
    return p;
}
void* operator new[](std::size_t size) {
    return operator new(size);
}
void operator delete(void* p) noexcept {
    std::free(p);
}
void operator delete[](void* p) noexcept {
    std::free(p);
}
void operator delete(void* p, std::size_t) noexcept {
    std::free(p);
}
void operator delete[](void* p, std::size_t) noexcept {
    std::free(p);
}

TEST_CASE("the allocation counter actually sees an allocation") {
    // Without this the real test below passes for the wrong reason: an
    // interposer that is never linked in, or a flag that never arms, counts
    // zero allocations no matter what the code under test does.
    g_allocations.store(0);
    g_armed.store(true);
    std::vector<double>* leak = new std::vector<double>();
    leak->resize(64);  // at least one heap allocation, probably two
    g_armed.store(false);
    const long seen = g_allocations.load();
    delete leak;
    CHECK(seen > 0);
}

TEST_CASE("probe accumulation and publication allocate nothing") {
    static const int kInputs = 8;
    static const int kFrames = 2205;  // one 50 ms window at 44.1 kHz

    // Everything the DSP path touches is constructed BEFORE arming: process()
    // owns these as members and never creates them per sample.
    ChannelAccumulator acc[kInputs][PROBE_MAX_CHANNELS];
    TelemetrySnapshotBuffer<ProbeWindowSnapshot> published[kInputs];
    uint16_t channelSeen[kInputs];
    for (int i = 0; i < kInputs; i++) {
        channelSeen[i] = 0;
        for (int c = 0; c < PROBE_MAX_CHANNELS; c++)
            acc[i][c].resetAll();
    }

    // Warm up unarmed, so a one-time lazy initialisation inside libm or the
    // runtime is not misread as a per-sample allocation.
    for (int c = 0; c < PROBE_MAX_CHANNELS; c++)
        acc[0][c].accumulate(0.5f, true);
    {
        ProbeWindowSnapshot warm;
        warm.sequence = 0;
        warm.windowFrames = 1;
        warm.sampleRate = 44100.f;
        warm.channelCount = 1;
        for (int c = 0; c < PROBE_MAX_CHANNELS; c++)
            warm.channels[c] = finalizeChannel(acc[0][c], 1);
        published[0].publish(warm);
    }
    for (int i = 0; i < kInputs; i++) {
        channelSeen[i] = 0;
        for (int c = 0; c < PROBE_MAX_CHANNELS; c++)
            acc[i][c].resetAll();
    }

    g_allocations.store(0);
    g_armed.store(true);

    // The inner loop of ProbeModule::process, one full window.
    for (int frame = 0; frame < kFrames; frame++) {
        for (int i = 0; i < kInputs; i++) {
            const uint8_t channels = (uint8_t) (1 + (i % PROBE_MAX_CHANNELS));
            uint16_t seen = channelSeen[i];
            for (uint8_t c = 0; c < channels; c++) {
                const uint16_t bit = (uint16_t) (1u << c);
                const bool first = (seen & bit) == 0;
                // Values that exercise every branch: clipping, gate edges, and
                // the non-finite guard.
                float v = 0.001f * (float) ((frame * 7 + c * 13 + i) % 4000 - 2000);
                if (frame % 997 == 0)
                    v = v / 0.f;  // inf, to hit the non-finite path
                acc[i][c].accumulate(v, first);
                if (first && std::isfinite(v))
                    seen |= bit;
            }
            channelSeen[i] = seen;
        }
    }

    // The window boundary: finalize and publish, exactly as process() does.
    for (int i = 0; i < kInputs; i++) {
        ProbeWindowSnapshot snap;
        snap.sequence = 1;
        snap.windowFrames = kFrames;
        snap.sampleRate = 44100.f;
        snap.channelCount = (uint8_t) (1 + (i % PROBE_MAX_CHANNELS));
        for (int c = 0; c < PROBE_MAX_CHANNELS; c++) {
            if (c < snap.channelCount)
                snap.channels[c] = finalizeChannel(acc[i][c], kFrames);
            else
                snap.channels[c] = ChannelStats();
        }
        published[i].publish(snap);
    }

    g_armed.store(false);
    // Read the counter into a local before CHECK: doctest's expression
    // decomposition allocates, and reading it inside the macro would race the
    // disarm on a failure path.
    const long allocations = g_allocations.load();
    CHECK(allocations == 0);
}

TEST_CASE("reading a published snapshot allocates nothing either") {
    // The UI and network side reads these too. It is not the audio thread, but
    // read() is a POD copy and a retry loop, and nothing about it should ever
    // need the heap.
    TelemetrySnapshotBuffer<ProbeWindowSnapshot> buffer;
    ProbeWindowSnapshot snap;
    snap.sequence = 3;
    snap.windowFrames = 64;
    snap.sampleRate = 48000.f;
    snap.channelCount = 2;
    for (int c = 0; c < PROBE_MAX_CHANNELS; c++)
        snap.channels[c] = ChannelStats();
    buffer.publish(snap);

    ProbeWindowSnapshot out;
    buffer.read(out);  // warm up

    g_allocations.store(0);
    g_armed.store(true);
    bool ok = true;
    for (int i = 0; i < 1000; i++)
        ok = buffer.read(out) && ok;
    g_armed.store(false);

    const long allocations = g_allocations.load();
    CHECK(ok);
    CHECK(allocations == 0);
    CHECK(out.sequence == 3);
}
