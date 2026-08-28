#include <doctest.h>
#include <cmath>
#include <limits>
#include "core/telemetry.hpp"

using namespace rackmcp;

static ChannelStats runWindow(const float* samples, uint32_t n, ChannelAccumulator& acc) {
    acc.reset();
    for (uint32_t i = 0; i < n; i++)
        acc.accumulate(samples[i], i == 0);
    return finalizeChannel(acc, n);
}

TEST_CASE("dc signal statistics") {
    ChannelAccumulator acc;
    acc.resetAll();
    float samples[100];
    for (int i = 0; i < 100; i++)
        samples[i] = 5.f;
    ChannelStats s = runWindow(samples, 100, acc);
    CHECK(s.minV == doctest::Approx(5.f));
    CHECK(s.maxV == doctest::Approx(5.f));
    CHECK(s.peakAbs == doctest::Approx(5.f));
    CHECK(s.mean == doctest::Approx(5.f));
    CHECK(s.rms == doctest::Approx(5.f));
    CHECK(s.clipped == 0);
    CHECK(s.nonFinite == 0);
}

TEST_CASE("sine statistics: rms = amp/sqrt(2), mean ~ 0") {
    ChannelAccumulator acc;
    acc.resetAll();
    const uint32_t N = 44100;
    static float samples[N];
    const float AMP = 5.f;
    for (uint32_t i = 0; i < N; i++)
        samples[i] = AMP * std::sin(2.0 * M_PI * 100.0 * i / N);
    ChannelStats s = runWindow(samples, N, acc);
    CHECK(s.rms == doctest::Approx(AMP / std::sqrt(2.f)).epsilon(0.001));
    CHECK(s.mean == doctest::Approx(0.f).epsilon(0.001));
    CHECK(s.minV == doctest::Approx(-AMP).epsilon(0.001));
    CHECK(s.maxV == doctest::Approx(AMP).epsilon(0.001));
    CHECK(s.clipped == 0);
}

TEST_CASE("clipping detection at +-10V") {
    ChannelAccumulator acc;
    acc.resetAll();
    float samples[5] = {9.99f, 10.f, -10.f, 11.f, -12.f};
    ChannelStats s = runWindow(samples, 5, acc);
    CHECK(s.clipped == 4);
    CHECK(s.peakAbs == doctest::Approx(12.f));
}

TEST_CASE("non-finite samples are counted and excluded from statistics") {
    ChannelAccumulator acc;
    acc.resetAll();
    float samples[6] = {1.f, std::numeric_limits<float>::quiet_NaN(), 3.f,
                        std::numeric_limits<float>::infinity(), 1.f, 3.f};
    ChannelStats s = runWindow(samples, 6, acc);
    CHECK(s.nonFinite == 2);
    CHECK(s.mean == doctest::Approx(2.f));
    CHECK(s.minV == doctest::Approx(1.f));
    CHECK(s.maxV == doctest::Approx(3.f));
    CHECK(std::isfinite(s.rms));
}

TEST_CASE("all-non-finite window yields zeroed safe statistics") {
    ChannelAccumulator acc;
    acc.resetAll();
    float nan = std::numeric_limits<float>::quiet_NaN();
    float samples[3] = {nan, nan, nan};
    ChannelStats s = runWindow(samples, 3, acc);
    CHECK(s.nonFinite == 3);
    CHECK(s.mean == 0.f);
    CHECK(s.rms == 0.f);
}

TEST_CASE("gate edge counting with hysteresis") {
    ChannelAccumulator acc;
    acc.resetAll();
    // Two clean gates, plus chatter around the high threshold that must not
    // retrigger without first crossing the low threshold.
    float samples[] = {0.f, 5.f, 5.f, 0.f, 5.f, 4.f, 5.f, 4.f, 0.05f, 5.f};
    ChannelStats s = runWindow(samples, sizeof(samples) / sizeof(samples[0]), acc);
    CHECK(s.risingEdges == 3);
}

TEST_CASE("gate state persists across window boundaries") {
    ChannelAccumulator acc;
    acc.resetAll();
    float w1[] = {0.f, 5.f, 5.f};
    runWindow(w1, 3, acc);
    // Still high entering window 2; no new edge until it drops low first.
    float w2[] = {5.f, 5.f, 0.f, 5.f};
    ChannelStats s2 = runWindow(w2, 4, acc);
    CHECK(s2.risingEdges == 1);
}
