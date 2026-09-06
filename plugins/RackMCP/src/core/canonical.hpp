#pragma once
// Canonical JSON serialization + SHA-256 fingerprinting over jansson values.
// Canonical form: UTF-8, objects with keys sorted bytewise, arrays in place,
// compact separators, reals encoded with 17 significant digits.
// No Rack dependencies (jansson only); C++11; unit tested out of tree.
#include <cstddef>
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

/**
 * Truncates `s` to at most `maxBytes` without splitting a UTF-8 sequence.
 * A trailing fragment would make jansson reject the string outright
 * (json_string validates UTF-8 and returns NULL), so every clamp applied to
 * untrusted plugin metadata (spec section 14) must go through this.
 */
void truncateUtf8(std::string& s, size_t maxBytes);

} // namespace rackmcp
