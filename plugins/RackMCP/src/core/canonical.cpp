#include "core/canonical.hpp"
#include "core/crypto.hpp"

#include <cmath>
#include <cstdlib>
#include <cstring>
#include <jansson.h>

namespace rackmcp {

std::string canonicalDumps(const json_t* value) {
    if (!value)
        return std::string();
    char* s = json_dumps(value, JSON_COMPACT | JSON_SORT_KEYS | JSON_ENCODE_ANY | JSON_REAL_PRECISION(17));
    if (!s)
        return std::string();
    std::string out(s);
    free(s);
    return out;
}

std::string canonicalFingerprint(const json_t* value) {
    return sha256Hex(canonicalDumps(value));
}

static bool checkRec(const json_t* value, int depth, int maxDepth, long& nodes, long maxNodes,
                     size_t maxStringBytes) {
    if (depth > maxDepth)
        return false;
    if (++nodes > maxNodes)
        return false;
    switch (json_typeof(value)) {
        case JSON_OBJECT: {
            const char* key;
            json_t* child;
            void* iter = json_object_iter((json_t*) value);
            while (iter) {
                key = json_object_iter_key(iter);
                child = json_object_iter_value(iter);
                if (strlen(key) > maxStringBytes)
                    return false;
                if (!checkRec(child, depth + 1, maxDepth, nodes, maxNodes, maxStringBytes))
                    return false;
                iter = json_object_iter_next((json_t*) value, iter);
            }
            return true;
        }
        case JSON_ARRAY: {
            size_t n = json_array_size(value);
            for (size_t i = 0; i < n; i++) {
                if (!checkRec(json_array_get(value, i), depth + 1, maxDepth, nodes, maxNodes,
                              maxStringBytes))
                    return false;
            }
            return true;
        }
        case JSON_STRING:
            return json_string_length(value) <= maxStringBytes;
        case JSON_REAL:
            return std::isfinite(json_real_value(value));
        default:
            return true;
    }
}

bool checkJsonLimits(const json_t* value, int maxDepth, long maxNodes, size_t maxStringBytes) {
    if (!value)
        return false;
    long nodes = 0;
    return checkRec(value, 1, maxDepth, nodes, maxNodes, maxStringBytes);
}

} // namespace rackmcp
