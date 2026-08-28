#include "core/uuid.hpp"
#include "core/crypto.hpp"

namespace rackmcp {

std::string uuid4() {
    uint8_t b[16];
    if (!randomBytes(b, sizeof(b)))
        return std::string();
    b[6] = (uint8_t) ((b[6] & 0x0f) | 0x40); // version 4
    b[8] = (uint8_t) ((b[8] & 0x3f) | 0x80); // variant 10
    std::string hex = toHex(b, 16);
    std::string out;
    out.reserve(36);
    out += hex.substr(0, 8);
    out += '-';
    out += hex.substr(8, 4);
    out += '-';
    out += hex.substr(12, 4);
    out += '-';
    out += hex.substr(16, 4);
    out += '-';
    out += hex.substr(20, 12);
    return out;
}

} // namespace rackmcp
