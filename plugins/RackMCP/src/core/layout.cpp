#include "core/layout.hpp"

#include <cmath>

namespace rackmcp {
namespace layout {

const size_t kNoSelf = (size_t) -1;

bool PlanLayout::isRemoved(int64_t moduleId) const {
    for (size_t i = 0; i < removedModules.size(); i++)
        if (removedModules[i] == moduleId)
            return true;
    return false;
}

const Box* PlanLayout::planned(int64_t moduleId) const {
    std::map<int64_t, Box>::const_iterator it = plannedBoxes.find(moduleId);
    return it == plannedBoxes.end() ? NULL : &it->second;
}

bool intersects(const Box& a, const Box& b) {
    // math.hpp:341-342, with `a` playing `this` and `b` playing `r`.
    return (b.size.x == INFINITY || a.pos.x < b.pos.x + b.size.x) &&
           (a.size.x == INFINITY || b.pos.x < a.pos.x + a.size.x) &&
           (b.size.y == INFINITY || a.pos.y < b.pos.y + b.size.y) &&
           (a.size.y == INFINITY || b.pos.y < a.pos.y + a.size.y);
}

Point gridToPixel(int gx, int gy, const Grid& grid) {
    return Point((gx + grid.originColumns) * grid.width, (gy + grid.originRows) * grid.height);
}

float rightmostEdge(const std::vector<Occupant>& occupants, const Grid& grid) {
    float maxX = gridToPixel(0, 0, grid).x;
    for (size_t i = 0; i < occupants.size(); i++) {
        if (!occupants[i].hasModuleId)
            continue;
        const float edge = occupants[i].box.right();
        if (edge > maxX)
            maxX = edge;
    }
    return maxX;
}

bool positionFree(const std::vector<Occupant>& occupants, size_t selfIndex, const Box& box,
                  const PlanLayout& plan) {
    for (size_t i = 0; i < occupants.size(); i++) {
        if (i == selfIndex)
            continue;
        const Occupant& other = occupants[i];
        Box otherBox = other.box;
        if (other.hasModuleId) {
            if (plan.isRemoved(other.moduleId))
                continue;
            const Box* replanned = plan.planned(other.moduleId);
            if (replanned)
                otherBox = *replanned;
        }
        if (intersects(box, otherBox))
            return false;
    }
    return true;
}

}  // namespace layout
}  // namespace rackmcp
