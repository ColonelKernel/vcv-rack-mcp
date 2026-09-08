// The first tests transaction validation has ever had.
//
// Every refusal a preview can make, and every entry in the diff the client is
// shown before it confirms, is decided by `validateOne`. Until the extraction
// this file accompanies, none of it could be reached from a test: it sat in
// `rackside/Transaction.cpp` between live Rack reads, and `tests/cpp` cannot
// link Rack. So the checks that stop a transaction severing its own control
// channel, that keep a `connect` from silently deleting a cable, and that
// bound a paramId before it indexes a vector were carried by review alone.
//
// The world these tests hand it is the same plain data `snapshotWorld` builds.
#include <doctest.h>
#include <cstdint>
#include <string>
#include <vector>

#include <jansson.h>

#include "core/layout.hpp"
#include "core/plan.hpp"
#include "core/validate.hpp"

using namespace rackmcp;

namespace {

/** Rack's real panel grid, so the pixel arithmetic matches the live one. */
layout::Grid grid() {
    return layout::Grid(15.0f, 380.0f);
}

/** Owns a parsed operation for the length of a CHECK. */
struct Op {
    json_t* j;
    explicit Op(const char* text) : j(json_loads(text, 0, NULL)) { REQUIRE(j != NULL); }
    ~Op() { json_decref(j); }
    operator json_t*() const { return j; }
};

/**
 * A patch: a VCO (id 1), a VCF (id 2), one Bridge (id 7), and an audio
 * interface (id 3), each with a panel three columns wide, laid out left to
 * right from grid column 0.
 */
PlanWorld patch() {
    PlanWorld w(grid());
    w.modules.push_back(WorldModule(1, "Fundamental", "VCO", 8, 4, 4));
    w.modules.push_back(WorldModule(2, "Fundamental", "VCF", 6, 3, 2));
    w.modules.push_back(WorldModule(3, "Core", "Audio-8", 1, 8, 8));
    w.modules.push_back(WorldModule(7, "RackMCP", "Bridge", 0, 0, 0));
    const float col = grid().width, row = grid().height;
    const float x0 = 2000 * col, y0 = 100 * row;
    w.occupants.push_back(layout::Occupant(1, layout::Box(x0 + 0 * col, y0, 3 * col, row)));
    w.occupants.push_back(layout::Occupant(2, layout::Box(x0 + 3 * col, y0, 3 * col, row)));
    w.occupants.push_back(layout::Occupant(3, layout::Box(x0 + 6 * col, y0, 3 * col, row)));
    w.occupants.push_back(layout::Occupant(7, layout::Box(x0 + 9 * col, y0, 3 * col, row)));
    return w;
}

/** vco:0 -> vcf:0, and vcf:0 -> audio:1. */
void wire(PlanWorld& w) {
    w.cables.push_back(PlanCable::connected(100, 1, 0, 2, 0));
    w.cables.push_back(PlanCable::connected(101, 2, 0, 3, 1));
}

struct Run {
    bool ok;
    ValidationError err;
    PreviewState st;
};

/** Validates a list of operations in order, stopping at the first refusal. */
Run run(const PlanWorld& w, const std::vector<std::string>& ops) {
    Run r;
    r.ok = true;
    for (size_t i = 0; i < ops.size(); i++) {
        Op op(ops[i].c_str());
        if (!validateOne(op, w, r.st, r.err)) {
            r.ok = false;
            break;
        }
    }
    return r;
}

Run run1(const PlanWorld& w, const std::string& op) {
    return run(w, std::vector<std::string>(1, op));
}

} // namespace

// ---------------------------------------------------------------------------
// Shape, before any accessor gets a default
// ---------------------------------------------------------------------------

TEST_CASE("a field of the wrong type is refused before an accessor defaults it") {
    // The whole reason checkOperationFields runs first: `jbool(op, "bypassed",
    // true)` and `json_integer_value` both answer for a string, and several of
    // those answers are the destructive one.
    PlanWorld w = patch();
    Run r = run1(w, "{\"op\":\"set_bypass\",\"module\":{\"moduleId\":\"1\"},\"bypassed\":\"false\"}");
    CHECK_FALSE(r.ok);
    CHECK(r.err.code == "BAD_REQUEST");
    CHECK(r.err.message.find("bypassed") != std::string::npos);
}

TEST_CASE("an unknown operation is refused rather than ignored") {
    PlanWorld w = patch();
    Run r = run1(w, "{\"op\":\"detonate\"}");
    CHECK_FALSE(r.ok);
    CHECK(r.err.code == "UNSUPPORTED_OPERATION");
}

TEST_CASE("duplicate_module is refused at preview, not at commit") {
    // Spec section 6: the previewed plan is the plan commit applies, so a
    // preview must not promise something apply cannot do.
    PlanWorld w = patch();
    Run r = run1(w, "{\"op\":\"duplicate_module\",\"module\":{\"moduleId\":\"1\"},"
                    "\"alias\":\"copy\",\"copyCables\":false,\"placement\":\"auto\"}");
    CHECK_FALSE(r.ok);
    CHECK(r.err.code == "UNSUPPORTED_OPERATION");
}

// ---------------------------------------------------------------------------
// add_module
// ---------------------------------------------------------------------------

TEST_CASE("a model the plan names but Rack did not resolve is refused") {
    PlanWorld w = patch();
    Run r = run1(w, "{\"op\":\"add_module\",\"pluginSlug\":\"Nope\",\"modelSlug\":\"Ghost\","
                    "\"alias\":\"g\",\"placement\":\"auto\"}");
    CHECK_FALSE(r.ok);
    CHECK(r.err.code == "MODEL_NOT_INSTALLED");
    CHECK(r.st.missingModule);
}

TEST_CASE("an installed model is accepted and makes the layout uncertain") {
    // The new panel's width is unknown until it is created at commit, so no
    // later collision check in the same plan may refuse anything.
    PlanWorld w = patch();
    w.installedModels.insert(ModelRef("Fundamental", "VCA"));
    Run r = run1(w, "{\"op\":\"add_module\",\"pluginSlug\":\"Fundamental\",\"modelSlug\":\"VCA\","
                    "\"alias\":\"vca\",\"placement\":\"auto\"}");
    CHECK(r.ok);
    CHECK(r.st.layoutUncertain);
    REQUIRE(r.st.addedModules.size() == 1);
    CHECK(r.st.addedModules[0].first == "vca");
    CHECK(r.st.aliases.count("vca") == 1);
    CHECK(r.st.aliases["vca"] < 0); // synthetic, so it cannot collide with a live id
    CHECK_FALSE(r.st.adapterUncertainty);
}

TEST_CASE("a module from an unknown vendor is flagged as semantically uncertain") {
    PlanWorld w = patch();
    w.installedModels.insert(ModelRef("Bogaudio", "VCO"));
    Run r = run1(w, "{\"op\":\"add_module\",\"pluginSlug\":\"Bogaudio\",\"modelSlug\":\"VCO\","
                    "\"alias\":\"b\",\"placement\":\"auto\"}");
    CHECK(r.ok);
    CHECK(r.st.adapterUncertainty);
}

TEST_CASE("adding a Core audio interface is flagged as touching audio") {
    PlanWorld w = patch();
    w.installedModels.insert(ModelRef("Core", "Audio-2"));
    Run r = run1(w, "{\"op\":\"add_module\",\"pluginSlug\":\"Core\",\"modelSlug\":\"Audio-2\","
                    "\"alias\":\"a\",\"placement\":\"auto\"}");
    CHECK(r.ok);
    CHECK(r.st.touchesAudio);
}

TEST_CASE("two operations cannot claim the same alias") {
    PlanWorld w = patch();
    w.installedModels.insert(ModelRef("Fundamental", "VCA"));
    const char* add = "{\"op\":\"add_module\",\"pluginSlug\":\"Fundamental\",\"modelSlug\":\"VCA\","
                      "\"alias\":\"x\",\"placement\":\"auto\"}";
    std::vector<std::string> ops;
    ops.push_back(add);
    ops.push_back(add);
    Run r = run(w, ops);
    CHECK_FALSE(r.ok);
    CHECK(r.err.code == "BAD_REQUEST");
}

// ---------------------------------------------------------------------------
// remove_module, and the refusal that protects the control channel
// ---------------------------------------------------------------------------

TEST_CASE("removing the only Bridge is refused unless the caller says so") {
    PlanWorld w = patch();
    Run r = run1(w, "{\"op\":\"remove_module\",\"module\":{\"moduleId\":\"7\"},"
                    "\"cablePolicy\":\"remove_attached\"}");
    CHECK_FALSE(r.ok);
    CHECK(r.err.code == "UNSUPPORTED_OPERATION");
    CHECK(r.st.removesBridge);
}

TEST_CASE("allowLastBridge is the caller taking responsibility for it") {
    PlanWorld w = patch();
    Run r = run1(w, "{\"op\":\"remove_module\",\"module\":{\"moduleId\":\"7\"},"
                    "\"cablePolicy\":\"remove_attached\",\"allowLastBridge\":true}");
    CHECK(r.ok);
    CHECK(r.st.removesBridge);
}

TEST_CASE("the last-Bridge count is against the plan, not against the live patch") {
    // With two Bridges installed, a two-operation plan removing both was once
    // permitted: each check saw two live Bridges and allowed the removal.
    PlanWorld w = patch();
    w.modules.push_back(WorldModule(9, "RackMCP", "Bridge", 0, 0, 0));
    std::vector<std::string> ops;
    ops.push_back("{\"op\":\"remove_module\",\"module\":{\"moduleId\":\"7\"},"
                  "\"cablePolicy\":\"remove_attached\"}");
    ops.push_back("{\"op\":\"remove_module\",\"module\":{\"moduleId\":\"9\"},"
                  "\"cablePolicy\":\"remove_attached\"}");
    Run r = run(w, ops);
    CHECK_FALSE(r.ok);
    CHECK(r.err.code == "UNSUPPORTED_OPERATION");
    CHECK(r.st.removedModules == std::vector<int64_t>(1, 7)); // the first one stood
}

TEST_CASE("fail_if_connected refuses rather than taking the cables with it") {
    PlanWorld w = patch();
    wire(w);
    Run r = run1(w, "{\"op\":\"remove_module\",\"module\":{\"moduleId\":\"2\"},"
                    "\"cablePolicy\":\"fail_if_connected\"}");
    CHECK_FALSE(r.ok);
    CHECK(r.err.code == "VALIDATION_FAILED");
}

TEST_CASE("remove_attached lists every cable it will take, so the diff discloses them") {
    PlanWorld w = patch();
    wire(w);
    Run r = run1(w, "{\"op\":\"remove_module\",\"module\":{\"moduleId\":\"2\"},"
                    "\"cablePolicy\":\"remove_attached\"}");
    CHECK(r.ok);
    CHECK(r.st.removedCables == std::vector<int64_t>({100, 101}));
    CHECK(r.st.removedModules == std::vector<int64_t>(1, 2));
}

TEST_CASE("a cable a removal already swept up is not counted twice") {
    PlanWorld w = patch();
    wire(w);
    std::vector<std::string> ops;
    ops.push_back("{\"op\":\"remove_module\",\"module\":{\"moduleId\":\"2\"},"
                  "\"cablePolicy\":\"remove_attached\"}");
    ops.push_back("{\"op\":\"remove_module\",\"module\":{\"moduleId\":\"1\"},"
                  "\"cablePolicy\":\"remove_attached\"}");
    Run r = run(w, ops);
    CHECK(r.ok);
    CHECK(r.st.removedCables == std::vector<int64_t>({100, 101}));
}

TEST_CASE("a module an earlier operation removed is gone for the rest of the plan") {
    PlanWorld w = patch();
    std::vector<std::string> ops;
    ops.push_back("{\"op\":\"remove_module\",\"module\":{\"moduleId\":\"1\"},"
                  "\"cablePolicy\":\"remove_attached\"}");
    ops.push_back("{\"op\":\"set_bypass\",\"module\":{\"moduleId\":\"1\"},\"bypassed\":true}");
    Run r = run(w, ops);
    CHECK_FALSE(r.ok);
    CHECK(r.err.code == "MODULE_NOT_FOUND");
}

TEST_CASE("removing an audio interface is flagged as touching audio") {
    PlanWorld w = patch();
    Run r = run1(w, "{\"op\":\"remove_module\",\"module\":{\"moduleId\":\"3\"},"
                    "\"cablePolicy\":\"remove_attached\"}");
    CHECK(r.ok);
    CHECK(r.st.touchesAudio);
}

// ---------------------------------------------------------------------------
// set_parameter bounds
// ---------------------------------------------------------------------------

TEST_CASE("a paramId past the end of the module is refused, not clamped") {
    PlanWorld w = patch();
    Run r = run1(w, "{\"op\":\"set_parameter\",\"module\":{\"moduleId\":\"2\"},"
                    "\"paramId\":6,\"value\":0.5}");
    CHECK_FALSE(r.ok);
    CHECK(r.err.code == "PARAMETER_NOT_FOUND");
    CHECK(run1(w, "{\"op\":\"set_parameter\",\"module\":{\"moduleId\":\"2\"},"
                  "\"paramId\":5,\"value\":0.5}").ok);
}

TEST_CASE("a negative paramId is refused before it indexes anything") {
    PlanWorld w = patch();
    Run r = run1(w, "{\"op\":\"set_parameter\",\"module\":{\"moduleId\":\"2\"},"
                    "\"paramId\":-1,\"value\":0.5}");
    CHECK_FALSE(r.ok);
    CHECK(r.err.code == "PARAMETER_NOT_FOUND");
}

TEST_CASE("a module the snapshot recorded no counts for accepts no param at all") {
    // Zero is the default for the counts, and it refuses everything. A snapshot
    // that failed to record them therefore produces an error the caller can
    // see, rather than an index into a vector that is not there.
    PlanWorld w(grid());
    w.modules.push_back(WorldModule(1, "Fundamental", "VCO"));
    Run r = run1(w, "{\"op\":\"set_parameter\",\"module\":{\"moduleId\":\"1\"},"
                    "\"paramId\":0,\"value\":0.5}");
    CHECK_FALSE(r.ok);
    CHECK(r.err.code == "PARAMETER_NOT_FOUND");
}

// ---------------------------------------------------------------------------
// move_module: the grid domain, and collisions
// ---------------------------------------------------------------------------

TEST_CASE("a grid column the schema forbids is refused rather than overflowing") {
    // gridToPixel adds Rack's 2000-column origin before scaling, so an x the
    // schema does not permit could reach a signed overflow inside Rack.
    PlanWorld w = patch();
    Run r = run1(w, "{\"op\":\"move_module\",\"module\":{\"moduleId\":\"1\"},"
                    "\"position\":{\"x\":2147483647,\"y\":0},\"collision\":\"fail\"}");
    CHECK_FALSE(r.ok);
    CHECK(r.err.code == "BAD_REQUEST");
    CHECK(r.err.message.find("range") != std::string::npos);
}

TEST_CASE("moving onto an occupied column is refused under the fail policy") {
    PlanWorld w = patch();
    Run r = run1(w, "{\"op\":\"move_module\",\"module\":{\"moduleId\":\"1\"},"
                    "\"position\":{\"x\":3,\"y\":0},\"collision\":\"fail\"}");
    CHECK_FALSE(r.ok);
    CHECK(r.err.code == "VALIDATION_FAILED");
}

TEST_CASE("a module does not collide with itself") {
    PlanWorld w = patch();
    Run r = run1(w, "{\"op\":\"move_module\",\"module\":{\"moduleId\":\"1\"},"
                    "\"position\":{\"x\":0,\"y\":0},\"collision\":\"fail\"}");
    CHECK(r.ok);
}

TEST_CASE("an empty column is free") {
    PlanWorld w = patch();
    Run r = run1(w, "{\"op\":\"move_module\",\"module\":{\"moduleId\":\"1\"},"
                    "\"position\":{\"x\":20,\"y\":0},\"collision\":\"fail\"}");
    CHECK(r.ok);
    CHECK(r.st.movedModules == std::vector<int64_t>(1, 1));
    CHECK(r.st.plannedBoxes.count(1) == 1); // lands exactly there
}

TEST_CASE("nearest and squeeze let Rack decide, so nothing later may be refused") {
    PlanWorld w = patch();
    Run r = run1(w, "{\"op\":\"move_module\",\"module\":{\"moduleId\":\"1\"},"
                    "\"position\":{\"x\":3,\"y\":0},\"collision\":\"nearest\"}");
    CHECK(r.ok);
    CHECK(r.st.layoutUncertain);
    CHECK(r.st.plannedBoxes.empty());
}

TEST_CASE("once the layout is uncertain, a collision cannot refuse anything") {
    // apply-time requestModulePos is the authority; a preview must never reject
    // a plan that would have committed.
    PlanWorld w = patch();
    w.installedModels.insert(ModelRef("Fundamental", "VCA"));
    std::vector<std::string> ops;
    ops.push_back("{\"op\":\"add_module\",\"pluginSlug\":\"Fundamental\",\"modelSlug\":\"VCA\","
                  "\"alias\":\"v\",\"placement\":\"auto\"}");
    ops.push_back("{\"op\":\"move_module\",\"module\":{\"moduleId\":\"1\"},"
                  "\"position\":{\"x\":3,\"y\":0},\"collision\":\"fail\"}");
    Run r = run(w, ops);
    CHECK(r.ok);
}

TEST_CASE("a module an earlier operation moved is judged where it is going") {
    PlanWorld w = patch();
    std::vector<std::string> ops;
    // The VCF vacates columns 3-5 ...
    ops.push_back("{\"op\":\"move_module\",\"module\":{\"moduleId\":\"2\"},"
                  "\"position\":{\"x\":20,\"y\":0},\"collision\":\"fail\"}");
    // ... so the VCO may take them.
    ops.push_back("{\"op\":\"move_module\",\"module\":{\"moduleId\":\"1\"},"
                  "\"position\":{\"x\":3,\"y\":0},\"collision\":\"fail\"}");
    Run r = run(w, ops);
    CHECK(r.ok);
}

TEST_CASE("a panel with no module is still an obstacle and never the mover") {
    // The case RackWidget::getModule would have crashed on rather than skipped:
    // it dereferences widget->module->id with no null check. Here the panel is
    // simply an occupant with no id -- it collides, and it can never be exempt.
    PlanWorld w = patch();
    const float col = grid().width, row = grid().height;
    const float x0 = 2000 * col, y0 = 100 * row;
    // Insert the id-less panel FIRST, where getModule would have met it before
    // reaching the module it was asked for.
    w.occupants.insert(w.occupants.begin(),
                       layout::Occupant(layout::Box(x0 + 20 * col, y0, 3 * col, row)));
    Run blocked = run1(w, "{\"op\":\"move_module\",\"module\":{\"moduleId\":\"1\"},"
                          "\"position\":{\"x\":20,\"y\":0},\"collision\":\"fail\"}");
    CHECK_FALSE(blocked.ok);
    CHECK(blocked.err.code == "VALIDATION_FAILED");
    // And the mover is still resolved correctly past it.
    Run free = run1(w, "{\"op\":\"move_module\",\"module\":{\"moduleId\":\"1\"},"
                       "\"position\":{\"x\":30,\"y\":0},\"collision\":\"fail\"}");
    CHECK(free.ok);
}

TEST_CASE("a module with no panel is moved without a collision check") {
    // getModule(id) returning NULL meant "no widget": the move is recorded and
    // nothing is refused, because there is no box to test.
    PlanWorld w = patch();
    w.occupants.clear();
    Run r = run1(w, "{\"op\":\"move_module\",\"module\":{\"moduleId\":\"1\"},"
                    "\"position\":{\"x\":3,\"y\":0},\"collision\":\"fail\"}");
    CHECK(r.ok);
    CHECK(r.st.movedModules == std::vector<int64_t>(1, 1));
    CHECK(r.st.plannedBoxes.empty());
}

// ---------------------------------------------------------------------------
// connect
// ---------------------------------------------------------------------------

TEST_CASE("a port past the end of the module is refused at preview") {
    PlanWorld w = patch();
    Run out = run1(w, "{\"op\":\"connect\",\"output\":{\"module\":{\"moduleId\":\"1\"},"
                      "\"portType\":\"output\",\"portId\":4},\"input\":{\"module\":"
                      "{\"moduleId\":\"2\"},\"portType\":\"input\",\"portId\":0},"
                      "\"inputPolicy\":\"fail_if_connected\"}");
    CHECK_FALSE(out.ok);
    CHECK(out.err.code == "PORT_NOT_FOUND");
    Run in = run1(w, "{\"op\":\"connect\",\"output\":{\"module\":{\"moduleId\":\"1\"},"
                     "\"portType\":\"output\",\"portId\":0},\"input\":{\"module\":"
                     "{\"moduleId\":\"2\"},\"portType\":\"input\",\"portId\":3},"
                     "\"inputPolicy\":\"fail_if_connected\"}");
    CHECK_FALSE(in.ok);
    CHECK(in.err.code == "PORT_NOT_FOUND");
}

TEST_CASE("connecting to a taken input is refused under fail_if_connected") {
    PlanWorld w = patch();
    wire(w);
    Run r = run1(w, "{\"op\":\"connect\",\"output\":{\"module\":{\"moduleId\":\"1\"},"
                    "\"portType\":\"output\",\"portId\":1},\"input\":{\"module\":"
                    "{\"moduleId\":\"2\"},\"portType\":\"input\",\"portId\":0},"
                    "\"inputPolicy\":\"fail_if_connected\"}");
    CHECK_FALSE(r.ok);
    CHECK(r.err.code == "VALIDATION_FAILED");
}

TEST_CASE("replace_all discloses the cable it deletes rather than deleting it quietly") {
    PlanWorld w = patch();
    wire(w);
    Run r = run1(w, "{\"op\":\"connect\",\"output\":{\"module\":{\"moduleId\":\"1\"},"
                    "\"portType\":\"output\",\"portId\":1},\"input\":{\"module\":"
                    "{\"moduleId\":\"2\"},\"portType\":\"input\",\"portId\":0},"
                    "\"inputPolicy\":\"replace_all\"}");
    CHECK(r.ok);
    CHECK(r.st.removedCables == std::vector<int64_t>(1, 100));
    REQUIRE(r.st.replacedInputs.size() == 1);
    CHECK(r.st.replacedInputs[0].first == 2);
    CHECK(r.st.replacedInputs[0].second == 0);
    CHECK(r.st.addedCables == 1);
}

TEST_CASE("stacking is refused, and says what to use instead") {
    PlanWorld w = patch();
    wire(w);
    Run r = run1(w, "{\"op\":\"connect\",\"output\":{\"module\":{\"moduleId\":\"1\"},"
                    "\"portType\":\"output\",\"portId\":1},\"input\":{\"module\":"
                    "{\"moduleId\":\"2\"},\"portType\":\"input\",\"portId\":0},"
                    "\"inputPolicy\":\"stack\"}");
    CHECK_FALSE(r.ok);
    CHECK(r.err.code == "UNSUPPORTED_OPERATION");
}

TEST_CASE("an input an earlier connect in the same plan took is already connected") {
    PlanWorld w = patch();
    const char* c = "{\"op\":\"connect\",\"output\":{\"module\":{\"moduleId\":\"1\"},"
                    "\"portType\":\"output\",\"portId\":0},\"input\":{\"module\":"
                    "{\"moduleId\":\"2\"},\"portType\":\"input\",\"portId\":0},"
                    "\"inputPolicy\":\"fail_if_connected\"}";
    std::vector<std::string> ops;
    ops.push_back(c);
    ops.push_back(c);
    Run r = run(w, ops);
    CHECK_FALSE(r.ok);
    CHECK(r.err.code == "VALIDATION_FAILED");
}

TEST_CASE("a cable an earlier operation removed no longer occupies its input") {
    PlanWorld w = patch();
    wire(w);
    std::vector<std::string> ops;
    ops.push_back("{\"op\":\"disconnect\",\"cable\":{\"cableId\":\"100\"}}");
    ops.push_back("{\"op\":\"connect\",\"output\":{\"module\":{\"moduleId\":\"1\"},"
                  "\"portType\":\"output\",\"portId\":1},\"input\":{\"module\":"
                  "{\"moduleId\":\"2\"},\"portType\":\"input\",\"portId\":0},"
                  "\"inputPolicy\":\"fail_if_connected\"}");
    Run r = run(w, ops);
    CHECK(r.ok);
}

TEST_CASE("connecting an audio interface is flagged as touching audio") {
    PlanWorld w = patch();
    Run r = run1(w, "{\"op\":\"connect\",\"output\":{\"module\":{\"moduleId\":\"2\"},"
                    "\"portType\":\"output\",\"portId\":0},\"input\":{\"module\":"
                    "{\"moduleId\":\"3\"},\"portType\":\"input\",\"portId\":0},"
                    "\"inputPolicy\":\"fail_if_connected\"}");
    CHECK(r.ok);
    CHECK(r.st.touchesAudio);
}

// ---------------------------------------------------------------------------
// disconnect and disconnect_port
// ---------------------------------------------------------------------------

TEST_CASE("a cable id that is not a decimal id is refused, and so is an empty one") {
    // strtoll answered 0 for "" and left endp on the terminator, so an empty
    // cableId used to reach the engine as cable 0.
    PlanWorld w = patch();
    wire(w);
    CHECK(run1(w, "{\"op\":\"disconnect\",\"cable\":{\"cableId\":\"\"}}").err.code ==
          "CABLE_NOT_FOUND");
    CHECK(run1(w, "{\"op\":\"disconnect\",\"cable\":{\"cableId\":\"-1\"}}").err.code ==
          "CABLE_NOT_FOUND");
    CHECK(run1(w, "{\"op\":\"disconnect\",\"cable\":{\"cableId\":\"12x\"}}").err.code ==
          "CABLE_NOT_FOUND");
    CHECK(run1(w, "{\"op\":\"disconnect\",\"cable\":{\"cableId\":\"999\"}}").err.code ==
          "CABLE_NOT_FOUND");
}

TEST_CASE("disconnecting the same cable twice in one plan is refused, and says why") {
    PlanWorld w = patch();
    wire(w);
    std::vector<std::string> ops;
    ops.push_back("{\"op\":\"disconnect\",\"cable\":{\"cableId\":\"100\"}}");
    ops.push_back("{\"op\":\"disconnect\",\"cable\":{\"cableId\":\"100\"}}");
    Run r = run(w, ops);
    CHECK_FALSE(r.ok);
    CHECK(r.err.code == "CABLE_NOT_FOUND");
    CHECK(r.err.message.find("already removed") != std::string::npos);
}

TEST_CASE("an unrecognised portType is refused, not treated as matching nothing") {
    // It used to make cablesOnPort match nothing, so disconnect_port became a
    // silent no-op that still reported success.
    PlanWorld w = patch();
    wire(w);
    Run r = run1(w, "{\"op\":\"disconnect_port\",\"port\":{\"module\":{\"moduleId\":\"2\"},"
                    "\"portType\":\"sideways\",\"portId\":0},\"policy\":\"all\"}");
    CHECK_FALSE(r.ok);
    CHECK(r.err.code == "BAD_REQUEST");
}

TEST_CASE("policy all removes every cable on the port") {
    PlanWorld w = patch();
    w.cables.push_back(PlanCable::connected(200, 1, 0, 2, 0));
    w.cables.push_back(PlanCable::connected(201, 1, 0, 3, 0));
    Run r = run1(w, "{\"op\":\"disconnect_port\",\"port\":{\"module\":{\"moduleId\":\"1\"},"
                    "\"portType\":\"output\",\"portId\":0},\"policy\":\"all\"}");
    CHECK(r.ok);
    CHECK(r.st.removedCables == std::vector<int64_t>({200, 201}));
}

TEST_CASE("policy top removes exactly one, the last in the order it was given") {
    PlanWorld w = patch();
    w.cables.push_back(PlanCable::connected(200, 1, 0, 2, 0));
    w.cables.push_back(PlanCable::connected(201, 1, 0, 3, 0));
    Run r = run1(w, "{\"op\":\"disconnect_port\",\"port\":{\"module\":{\"moduleId\":\"1\"},"
                    "\"portType\":\"output\",\"portId\":0},\"policy\":\"top\"}");
    CHECK(r.ok);
    CHECK(r.st.removedCables == std::vector<int64_t>(1, 201));
}

TEST_CASE("disconnect_port on a module that is gone is refused") {
    PlanWorld w = patch();
    Run r = run1(w, "{\"op\":\"disconnect_port\",\"port\":{\"module\":{\"moduleId\":\"99\"},"
                    "\"portType\":\"input\",\"portId\":0},\"policy\":\"all\"}");
    CHECK_FALSE(r.ok);
    CHECK(r.err.code == "MODULE_NOT_FOUND");
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

TEST_CASE("an alias an earlier operation declared resolves for a later one") {
    PlanWorld w = patch();
    w.installedModels.insert(ModelRef("Fundamental", "VCA"));
    std::vector<std::string> ops;
    ops.push_back("{\"op\":\"add_module\",\"pluginSlug\":\"Fundamental\",\"modelSlug\":\"VCA\","
                  "\"alias\":\"vca\",\"placement\":\"auto\"}");
    ops.push_back("{\"op\":\"set_bypass\",\"module\":{\"alias\":\"vca\"},\"bypassed\":true}");
    Run r = run(w, ops);
    CHECK(r.ok);
    REQUIRE(r.st.modifiedModules.size() == 1);
    CHECK(r.st.modifiedModules[0] < 0); // the synthetic id, applied after the add
}

TEST_CASE("an alias nothing declared is refused") {
    PlanWorld w = patch();
    Run r = run1(w, "{\"op\":\"set_bypass\",\"module\":{\"alias\":\"ghost\"},\"bypassed\":true}");
    CHECK_FALSE(r.ok);
    CHECK(r.err.code == "MODULE_NOT_FOUND");
}
