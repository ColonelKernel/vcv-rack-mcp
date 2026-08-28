#pragma once
#include <string>

namespace rackmcp {
/** RFC 4122 version-4 UUID from the OS CSPRNG. Empty string on RNG failure. */
std::string uuid4();
} // namespace rackmcp
