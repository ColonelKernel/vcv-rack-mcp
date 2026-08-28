// libFuzzer harness for the bridge frame decoder.
// Build with -DRACKMCP_BUILD_FUZZERS=ON (requires clang with libFuzzer;
// on macOS use Homebrew LLVM — Apple clang does not ship libFuzzer).
#include <cstddef>
#include <cstdint>
#include <string>
#include "core/framing.hpp"

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
    // Interpret the first byte as a chunking seed so we exercise partial reads.
    if (size == 0)
        return 0;
    size_t chunk = (size_t) (data[0] % 17) + 1;
    rackmcp::FrameDecoder d(64 * 1024);
    std::string frame;
    size_t off = 1;
    while (off < size) {
        size_t n = size - off < chunk ? size - off : chunk;
        if (!d.push(data + off, n))
            break;
        while (d.next(frame)) {
            // consume
        }
        off += n;
    }
    return 0;
}
