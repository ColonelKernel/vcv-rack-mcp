#pragma once
// Rack panel geometry as pure arithmetic.
//
// Every function here was inlined in rackside/Transaction.cpp among live Rack
// reads, which is why none of it had a test: collision, auto-placement and
// grid conversion decide whether a transaction is refused, and all three were
// only exercisable by running Rack and looking.
//
// The grid dimensions are PARAMETERS, not constants copied from the SDK. That
// is deliberate. RACK_GRID_WIDTH is `static const float` (app/common.hpp:18),
// so C++11 cannot static_assert a local copy against it -- an lvalue-to-rvalue
// conversion on a non-integral const is not a constant expression -- and a
// runtime or text-scanning check would have to live in tests/cpp, whose CI job
// never fetches the SDK and so could never fail. Rather than guard a copy that
// cannot be guarded, there is no copy: rackside passes Rack's own values in.
#include <cstddef>
#include <cstdint>
#include <map>
#include <vector>

namespace rackmcp {
namespace layout {

struct Point {
    float x, y;
    Point() : x(0.f), y(0.f) {}
    Point(float x_, float y_) : x(x_), y(y_) {}
};

struct Box {
    Point pos, size;
    Box() {}
    Box(Point pos_, Point size_) : pos(pos_), size(size_) {}
    Box(float x, float y, float w, float h) : pos(x, y), size(w, h) {}
    float right() const { return pos.x + size.x; }
};

/**
 * Grid geometry, supplied by the caller.
 *
 * `width`/`height` are Rack's RACK_GRID_WIDTH / RACK_GRID_HEIGHT. The origin
 * offset is Rack's own convention (app/common.hpp:21 builds RACK_OFFSET as the
 * grid size times (2000, 100)), spelled as literals by the code this replaces.
 */
struct Grid {
    float width, height;
    int originColumns, originRows;
    Grid(float width_, float height_)
        : width(width_), height(height_), originColumns(2000), originRows(100) {}
};

/**
 * A panel occupying space on the rack: one entry per ModuleWidget.
 *
 * `hasModuleId` is false for a widget whose `module` is NULL. Such a panel is
 * still an obstacle -- it has no id to be removed or re-planned by, but it
 * still collides -- and a container keyed by module id could not represent it,
 * which is why this is a vector rather than a map.
 */
struct Occupant {
    bool hasModuleId;
    int64_t moduleId;
    Box box;
    Occupant() : hasModuleId(false), moduleId(-1) {}
    Occupant(int64_t moduleId_, const Box& box_)
        : hasModuleId(true), moduleId(moduleId_), box(box_) {}
    explicit Occupant(const Box& box_) : hasModuleId(false), moduleId(-1), box(box_) {}
};

/** What earlier operations in the same plan already did to the layout. */
struct PlanLayout {
    std::vector<int64_t> removedModules;
    std::map<int64_t, Box> plannedBoxes;
    bool isRemoved(int64_t moduleId) const;
    /** The box an earlier operation put this module in, or NULL. */
    const Box* planned(int64_t moduleId) const;
};

/** Passed as `selfIndex` when no occupant is exempt. */
extern const size_t kNoSelf;

/**
 * Rack's own rectangle overlap test (math.hpp:340-343, reached via
 * Rect::isIntersecting at :445). Transcribed rather than reimplemented,
 * INFINITY cases included.
 *
 * The comparisons are STRICT: two panels sharing an edge do not intersect,
 * which is what lets modules sit flush against each other. Relaxing either
 * `<` to `<=` turns every tight placement into a refused transaction.
 */
bool intersects(const Box& a, const Box& b);

/** Grid coordinates to pixels (Transaction.cpp:97-99). */
Point gridToPixel(int gx, int gy, const Grid& grid);

/**
 * Rightmost occupied pixel x, for `placement: "auto"`; never less than the
 * origin, so an empty rack places at column 0.
 *
 * Counts only occupants carrying a module id, so a caller may hand it the same
 * list positionFree gets. The plugin instead builds the list from the engine's
 * own module ids, which is what the code this replaces did -- keeping the two
 * exactly equivalent rather than merely equivalent in practice.
 */
float rightmostEdge(const std::vector<Occupant>& occupants, const Grid& grid);

/**
 * Whether `box` is clear of every occupant except `occupants[selfIndex]`.
 *
 * `selfIndex` is an INDEX, not a module id, because the original compared
 * widget pointers: the moving module is exempt by identity, and a module-less
 * panel can never be the mover but is still an obstacle. Resolving "self" by
 * id instead would exempt a different set whenever a module has no widget or a
 * widget has no module. Pass kNoSelf to exempt nothing.
 *
 * A removed module is not an obstacle; a module an earlier operation moved is
 * judged at its planned position rather than the one it still occupies.
 */
bool positionFree(const std::vector<Occupant>& occupants, size_t selfIndex, const Box& box,
                  const PlanLayout& plan);

}  // namespace layout
}  // namespace rackmcp
