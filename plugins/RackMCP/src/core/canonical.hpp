#pragma once
// Canonical JSON serialization + SHA-256 fingerprinting over jansson values.
// Canonical form: UTF-8, objects with keys sorted bytewise, arrays in place,
// compact separators, reals encoded with 17 significant digits.
// No Rack dependencies (jansson only); C++11; unit tested out of tree.
#include <string>

typedef struct json_t json_t;

namespace rackmcp {

/** Canonical dump. Returns empty string only for null input. */
std::string canonicalDumps(const json_t* value);

/** SHA-256 hex of the canonical dump. */
std::string canonicalFingerprint(const json_t* value);

/**
 * JSON boundary guard (spec section 14): depth, node count, and string size
 * limits, plus rejection of NaN/infinity reals. Returns false when violated.
 */
bool checkJsonLimits(const json_t* value, int maxDepth, long maxNodes, size_t maxStringBytes);

} // namespace rackmcp
