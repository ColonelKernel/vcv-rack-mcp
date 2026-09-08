#include <doctest.h>
#include <stdexcept>
#include <string>
#include <vector>
#include "core/rollback.hpp"

using namespace rackmcp;

namespace {

/**
 * Stands in for `rack::history::Action`. Records the order it was undone in,
 * because "newest first" is the half of the contract a count cannot express:
 * a loop that ran every inverse but ran them oldest-first would produce the
 * same `executed` and the wrong patch.
 */
struct FakeAction {
    int id;
    int throwKind; // 0 none, 1 std::string, 2 std::exception, 3 an int
    std::vector<int>* order;

    FakeAction(int id_, std::vector<int>* order_, int throwKind_ = 0)
        : id(id_), throwKind(throwKind_), order(order_) {}

    void undo() {
        order->push_back(id);
        if (throwKind == 1)
            throw std::string("inverse ") + std::to_string(id) + " refused";
        if (throwKind == 2)
            throw std::runtime_error("rack said no");
        if (throwKind == 3)
            throw 7;
    }
};

/** Owns the fakes so each case reads as a list rather than as bookkeeping. */
struct Fakes {
    std::vector<int> order;
    std::vector<FakeAction*> actions;

    ~Fakes() {
        for (size_t i = 0; i < actions.size(); i++)
            delete actions[i];
    }

    void push(int id, int throwKind = 0) {
        actions.push_back(new FakeAction(id, &order, throwKind));
    }
};

} // namespace

TEST_CASE("every inverse runs, newest first, and all of them are counted") {
    Fakes f;
    f.push(1);
    f.push(2);
    f.push(3);

    const InverseRun run = runInverses(f.actions);

    CHECK(run.executed == 3);
    CHECK_FALSE(run.threw);
    CHECK(run.detail.empty());
    // Reverse order is the point: Rack's own ComplexAction::undo replays
    // backwards so a dependent is undone before the thing it depends on.
    REQUIRE(f.order.size() == 3);
    CHECK(f.order[0] == 3);
    CHECK(f.order[1] == 2);
    CHECK(f.order[2] == 1);
}

TEST_CASE("an empty action list is a complete rollback of nothing") {
    Fakes f;
    const InverseRun run = runInverses(f.actions);
    CHECK(run.executed == 0);
    CHECK_FALSE(run.threw);
}

TEST_CASE("a throwing inverse stops the loop and is not counted as executed") {
    // This is the case the old report could not describe: it emitted the same
    // number whether every inverse ran or none did.
    // Pushed oldest to newest, so 4 is the newest and runs first.
    Fakes f;
    f.push(1);
    f.push(2);
    f.push(3, 1);
    f.push(4);

    const InverseRun run = runInverses(f.actions);

    // Runs 4, then 3 which throws. 2 and 1 never run.
    CHECK(run.executed == 1);
    CHECK(run.threw);
    CHECK(run.detail == "inverse 3 refused");
    REQUIRE(f.order.size() == 2);
    CHECK(f.order[0] == 4);
    CHECK(f.order[1] == 3);
}

TEST_CASE("the oldest inverse throwing still counts everything ahead of it") {
    Fakes f;
    f.push(1, 1); // oldest, so it runs last
    f.push(2);
    f.push(3);

    const InverseRun run = runInverses(f.actions);

    CHECK(run.executed == 2);
    CHECK(run.threw);
    CHECK(run.detail == "inverse 1 refused");
}

TEST_CASE("the newest inverse throwing counts nothing") {
    Fakes f;
    f.push(1);
    f.push(2, 1); // newest, runs first

    const InverseRun run = runInverses(f.actions);

    CHECK(run.executed == 0);
    CHECK(run.threw);
    // The count and the flag say different things, and both are needed: zero
    // executed with threw=false would be an empty transaction, while zero with
    // threw=true is a rollback that could not start.
    CHECK(f.order.size() == 1);
}

TEST_CASE("all three throw conventions are caught and reported") {
    // Rack and third-party plugins throw std::exception subclasses; this
    // plugin throws std::string; a plugin may throw neither.
    {
        Fakes f;
        f.push(1, 2);
        const InverseRun run = runInverses(f.actions);
        CHECK(run.threw);
        CHECK(run.detail == "rack said no");
    }
    {
        Fakes f;
        f.push(1, 3);
        const InverseRun run = runInverses(f.actions);
        CHECK(run.threw);
        // No what() to quote, so the message says what happened rather than
        // leaving the operator with an empty reason.
        CHECK(run.detail == "an inverse action threw");
    }
}

TEST_CASE("executed is the count of inverses, not of plan operations") {
    // The defect this replaces, stated as a test. One `remove_module` with
    // three attached cables pushes four inverses (three CableRemove plus one
    // ModuleRemove) while the old report said "1", because it counted the
    // operation. An operator reading "1" after a four-inverse rollback has no
    // way to tell a complete rollback from a stalled one.
    Fakes f;
    f.push(1); // CableRemove
    f.push(2); // CableRemove
    f.push(3); // CableRemove
    f.push(4); // ModuleRemove

    const InverseRun run = runInverses(f.actions);

    CHECK(run.executed == 4);
    CHECK(run.executed != 1);
}
