#include <doctest.h>
#include <cmath>
#include <vector>
#include "core/layout.hpp"

using namespace rackmcp;
using namespace rackmcp::layout;

/** Rack's real geometry, as the plugin passes it in. */
static Grid rackGrid() {
    return Grid(15.f, 380.f);
}

static Box hp(float columns, float x, float y) {
    return Box(x, y, columns * 15.f, 380.f);
}

TEST_CASE("grid coordinates convert the way Rack lays out a rack") {
    const Grid g = rackGrid();
    // Transaction.cpp:98: (gx + 2000) * width, (gy + 100) * height.
    CHECK(gridToPixel(0, 0, g).x == doctest::Approx(30000.f));
    CHECK(gridToPixel(0, 0, g).y == doctest::Approx(38000.f));
    CHECK(gridToPixel(1, 0, g).x == doctest::Approx(30015.f));
    CHECK(gridToPixel(-1, 0, g).x == doctest::Approx(29985.f));
    CHECK(gridToPixel(0, 1, g).y == doctest::Approx(38380.f));
    // One grid column apart, exactly.
    CHECK(gridToPixel(4, 0, g).x - gridToPixel(3, 0, g).x == doctest::Approx(15.f));
}

TEST_CASE("the grid comes from the caller, so a different grid really is different") {
    // The point of taking Grid as a parameter rather than copying
    // RACK_GRID_WIDTH into core/: nothing here can silently disagree with the
    // SDK, because nothing here remembers what the SDK said.
    CHECK(gridToPixel(1, 0, Grid(20.f, 380.f)).x == doctest::Approx((1 + 2000) * 20.f));
    CHECK(gridToPixel(0, 1, Grid(15.f, 400.f)).y == doctest::Approx((1 + 100) * 400.f));
}

TEST_CASE("panels that merely touch do not collide") {
    // This is the assertion that matters most. Rack's test is strict `<`
    // (math.hpp:341-342), so modules sit flush. Relaxing either comparison to
    // `<=` refuses every tight placement, and the transaction fails with
    // "target position is occupied" for a layout Rack would have accepted.
    const Box left = hp(8, 0.f, 0.f);          // occupies x [0, 120)
    const Box abutting = hp(8, 120.f, 0.f);    // starts exactly where left ends
    CHECK_FALSE(intersects(left, abutting));
    CHECK_FALSE(intersects(abutting, left));

    const Box overlapByOne = hp(8, 119.f, 0.f);
    CHECK(intersects(left, overlapByOne));
    CHECK(intersects(overlapByOne, left));
}

TEST_CASE("collision is symmetric, and misses on either axis alone") {
    const Box a = hp(4, 0.f, 0.f);
    CHECK(intersects(a, a));
    // Same columns, a row down: no overlap in y.
    CHECK_FALSE(intersects(a, hp(4, 0.f, 380.f)));
    // Overlapping in y but not x.
    CHECK_FALSE(intersects(a, hp(4, 60.f, 0.f)));
    // Overlapping in both.
    CHECK(intersects(a, hp(4, 30.f, 100.f)));
}

TEST_CASE("an infinite extent swallows everything on that axis") {
    Box unbounded(0.f, 0.f, INFINITY, 380.f);
    CHECK(intersects(unbounded, hp(4, 1e9f, 0.f)));
    CHECK(intersects(hp(4, 1e9f, 0.f), unbounded));
    // Still bounded in y.
    CHECK_FALSE(intersects(unbounded, hp(4, 1e9f, 380.f)));
}

TEST_CASE("the INFINITY guard is what decides a box that starts at negative infinity") {
    // Deleting the `size.x == INFINITY ||` guards from intersects passes every
    // other test in this file AND a two-million-pair differential against
    // rack::math::Rect -- because for a finite pos, pos + INFINITY is INFINITY
    // and `x < INFINITY` is already true. The guard is arithmetically redundant
    // there, so nothing above pins it.
    //
    // It stops being redundant at -INFINITY, where pos + size is NaN and every
    // comparison against NaN is false: without the guard a box spanning the
    // whole axis would intersect nothing at all. This is the only case that
    // holds the transcription to math.hpp:341-342 rather than to something that
    // merely agrees with it on reachable input.
    Box wholeAxis(-INFINITY, 0.f, INFINITY, 380.f);
    CHECK(intersects(wholeAxis, hp(4, 0.f, 0.f)));
    CHECK(intersects(hp(4, 0.f, 0.f), wholeAxis));
    CHECK(intersects(wholeAxis, hp(4, -1e9f, 0.f)));
    // The y axis is still finite and still decides.
    CHECK_FALSE(intersects(wholeAxis, hp(4, 0.f, 380.f)));
}

TEST_CASE("an empty rack places at the origin") {
    CHECK(rightmostEdge(std::vector<Occupant>(), rackGrid()) ==
          doctest::Approx(gridToPixel(0, 0, rackGrid()).x));
}

TEST_CASE("automatic placement lands past the rightmost panel") {
    const Grid g = rackGrid();
    const float origin = gridToPixel(0, 0, g).x;
    std::vector<Occupant> occ;
    occ.push_back(Occupant(1, Box(origin, 0.f, 120.f, 380.f)));
    occ.push_back(Occupant(2, Box(origin + 300.f, 0.f, 45.f, 380.f)));
    occ.push_back(Occupant(3, Box(origin + 120.f, 0.f, 30.f, 380.f)));
    CHECK(rightmostEdge(occ, g) == doctest::Approx(origin + 345.f));
}

TEST_CASE("a panel to the left of the origin does not drag placement backwards") {
    // maxX starts at the origin, so a module dragged into negative columns
    // must not cause the next auto-placed module to land on top of something.
    const Grid g = rackGrid();
    const float origin = gridToPixel(0, 0, g).x;
    std::vector<Occupant> occ;
    occ.push_back(Occupant(1, Box(origin - 600.f, 0.f, 120.f, 380.f)));
    CHECK(rightmostEdge(occ, g) == doctest::Approx(origin));
}

TEST_CASE("a panel with no module does not count towards placement") {
    // It is still an obstacle for collision (below), but the code this
    // replaces reached panels through engine module ids and so never saw it.
    const Grid g = rackGrid();
    const float origin = gridToPixel(0, 0, g).x;
    std::vector<Occupant> occ;
    occ.push_back(Occupant(Box(origin + 900.f, 0.f, 120.f, 380.f)));
    CHECK(rightmostEdge(occ, g) == doctest::Approx(origin));
}

TEST_CASE("a free position is free") {
    std::vector<Occupant> occ;
    occ.push_back(Occupant(1, hp(8, 0.f, 0.f)));
    CHECK(positionFree(occ, kNoSelf, hp(8, 200.f, 0.f), PlanLayout()));
    CHECK_FALSE(positionFree(occ, kNoSelf, hp(8, 60.f, 0.f), PlanLayout()));
}

TEST_CASE("a module does not collide with itself") {
    // The mover is exempt by INDEX, not by id: it is the panel being moved,
    // and Rack identified it by widget pointer.
    std::vector<Occupant> occ;
    occ.push_back(Occupant(1, hp(8, 0.f, 0.f)));
    occ.push_back(Occupant(2, hp(8, 200.f, 0.f)));
    // Module 1 nudged slightly right still overlaps only its own old box.
    CHECK(positionFree(occ, 0, hp(8, 10.f, 0.f), PlanLayout()));
    // Without the exemption it would refuse.
    CHECK_FALSE(positionFree(occ, kNoSelf, hp(8, 10.f, 0.f), PlanLayout()));
    // Exempting the wrong occupant does not help.
    CHECK_FALSE(positionFree(occ, 1, hp(8, 10.f, 0.f), PlanLayout()));
}

TEST_CASE("self is one panel, not every panel sharing its module id") {
    // Resolving self by module id instead of by index passes the test above,
    // because there every id is distinct. It stops passing here.
    //
    // RackWidget::getModule and getModules carry no documented uniqueness
    // contract and RackWidget::Internal is opaque, so two panels reporting one
    // module id cannot be ruled out from the SDK. The original compared widget
    // POINTERS: it exempted the one panel being moved and nothing else. An
    // id-based version would exempt both and report a collision as clear.
    std::vector<Occupant> occ;
    occ.push_back(Occupant(7, hp(8, 0.f, 0.f)));
    occ.push_back(Occupant(7, hp(8, 200.f, 0.f)));

    // Moving the first panel onto the second must still be refused.
    CHECK_FALSE(positionFree(occ, 0, hp(8, 200.f, 0.f), PlanLayout()));
    // And moving it somewhere empty is still allowed.
    CHECK(positionFree(occ, 0, hp(8, 400.f, 0.f), PlanLayout()));
}

TEST_CASE("a panel with no module is still an obstacle") {
    // A map keyed by module id could not express this, which is why the
    // occupant list is a vector. It has no id, so it can never be removed or
    // re-planned -- it just sits there and collides.
    std::vector<Occupant> occ;
    occ.push_back(Occupant(hp(8, 0.f, 0.f)));
    CHECK_FALSE(positionFree(occ, kNoSelf, hp(8, 60.f, 0.f), PlanLayout()));

    PlanLayout plan;
    plan.removedModules.push_back(-1);  // the sentinel id must not excuse it
    CHECK_FALSE(positionFree(occ, kNoSelf, hp(8, 60.f, 0.f), plan));
}

TEST_CASE("a module this plan removes is not in the way") {
    std::vector<Occupant> occ;
    occ.push_back(Occupant(7, hp(8, 0.f, 0.f)));
    CHECK_FALSE(positionFree(occ, kNoSelf, hp(8, 60.f, 0.f), PlanLayout()));

    PlanLayout plan;
    plan.removedModules.push_back(7);
    CHECK(positionFree(occ, kNoSelf, hp(8, 60.f, 0.f), plan));
}

TEST_CASE("a module this plan already moved is judged where the plan put it") {
    // Both directions matter: an earlier move can free a space, and it can
    // also occupy one that was empty a moment ago.
    std::vector<Occupant> occ;
    occ.push_back(Occupant(7, hp(8, 0.f, 0.f)));

    PlanLayout movedAway;
    movedAway.plannedBoxes[7] = hp(8, 500.f, 0.f);
    CHECK(positionFree(occ, kNoSelf, hp(8, 60.f, 0.f), movedAway));

    PlanLayout movedInto;
    movedInto.plannedBoxes[7] = hp(8, 480.f, 0.f);
    CHECK_FALSE(positionFree(occ, kNoSelf, hp(8, 500.f, 0.f), movedInto));
}

TEST_CASE("removal wins over a planned position for the same module") {
    // Order matters: a module both moved and removed by the same plan is gone,
    // not sitting at its planned box.
    std::vector<Occupant> occ;
    occ.push_back(Occupant(7, hp(8, 0.f, 0.f)));
    PlanLayout plan;
    plan.plannedBoxes[7] = hp(8, 500.f, 0.f);
    plan.removedModules.push_back(7);
    CHECK(positionFree(occ, kNoSelf, hp(8, 500.f, 0.f), plan));
}
