#pragma once
// SHA-256, HMAC-SHA256, constant-time comparison, hex codecs, and secure
// random bytes. No Rack dependencies; C++11; unit tested out of tree.
#include <cstddef>
#include <cstdint>
#include <string>

namespace rackmcp {

/** FIPS 180-4 SHA-256. */
class Sha256 {
public:
    Sha256();
    void update(const void* data, size_t len);
    /** Finalizes into 32 bytes. The object must not be reused afterwards. */
    void finish(uint8_t out[32]);

private:
    void processBlock(const uint8_t block[64]);
    uint32_t state_[8];
    uint64_t bitLen_ = 0;
    uint8_t buffer_[64];
    size_t bufferLen_ = 0;
};

/** One-shot SHA-256 -> lowercase hex. */
std::string sha256Hex(const std::string& data);

/** RFC 2104 HMAC-SHA256 -> 32 raw bytes appended to out. */
void hmacSha256(const std::string& key, const std::string& message, uint8_t out[32]);

/** HMAC-SHA256 -> lowercase hex. */
std::string hmacSha256Hex(const std::string& key, const std::string& message);

/** Constant-time equality. Returns false for length mismatches (length may leak). */
bool constantTimeEqual(const std::string& a, const std::string& b);

std::string toHex(const uint8_t* data, size_t len);
/** Strict lowercase/uppercase hex decode; returns false on invalid input. */
bool fromHex(const std::string& hex, std::string& out);

/** Cryptographically secure random bytes from the OS. Returns false on failure. */
bool randomBytes(uint8_t* out, size_t len);
std::string randomHex(size_t nBytes);

} // namespace rackmcp
