#include "core/crypto.hpp"

#include <cstring>

#if defined(_WIN32)
#include <windows.h>
#include <bcrypt.h>
#else
#include <fcntl.h>
#include <unistd.h>
#endif

namespace rackmcp {

static const uint32_t K[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
};

static inline uint32_t rotr(uint32_t x, int n) {
    return (x >> n) | (x << (32 - n));
}

Sha256::Sha256() {
    state_[0] = 0x6a09e667;
    state_[1] = 0xbb67ae85;
    state_[2] = 0x3c6ef372;
    state_[3] = 0xa54ff53a;
    state_[4] = 0x510e527f;
    state_[5] = 0x9b05688c;
    state_[6] = 0x1f83d9ab;
    state_[7] = 0x5be0cd19;
}

void Sha256::processBlock(const uint8_t block[64]) {
    uint32_t w[64];
    for (int i = 0; i < 16; i++) {
        w[i] = ((uint32_t) block[i * 4] << 24) | ((uint32_t) block[i * 4 + 1] << 16) |
               ((uint32_t) block[i * 4 + 2] << 8) | (uint32_t) block[i * 4 + 3];
    }
    for (int i = 16; i < 64; i++) {
        uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
        uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
        w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    uint32_t a = state_[0], b = state_[1], c = state_[2], d = state_[3];
    uint32_t e = state_[4], f = state_[5], g = state_[6], h = state_[7];
    for (int i = 0; i < 64; i++) {
        uint32_t S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        uint32_t ch = (e & f) ^ (~e & g);
        uint32_t t1 = h + S1 + ch + K[i] + w[i];
        uint32_t S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
        uint32_t t2 = S0 + maj;
        h = g;
        g = f;
        f = e;
        e = d + t1;
        d = c;
        c = b;
        b = a;
        a = t1 + t2;
    }
    state_[0] += a;
    state_[1] += b;
    state_[2] += c;
    state_[3] += d;
    state_[4] += e;
    state_[5] += f;
    state_[6] += g;
    state_[7] += h;
}

void Sha256::update(const void* data, size_t len) {
    const uint8_t* p = (const uint8_t*) data;
    bitLen_ += (uint64_t) len * 8;
    while (len > 0) {
        size_t take = 64 - bufferLen_;
        if (take > len)
            take = len;
        std::memcpy(buffer_ + bufferLen_, p, take);
        bufferLen_ += take;
        p += take;
        len -= take;
        if (bufferLen_ == 64) {
            processBlock(buffer_);
            bufferLen_ = 0;
        }
    }
}

void Sha256::finish(uint8_t out[32]) {
    // Capture the message length before any padding bytes are absorbed.
    uint64_t messageBits = bitLen_;
    uint8_t pad = 0x80;
    update(&pad, 1);
    uint8_t zero = 0x00;
    while (bufferLen_ != 56)
        update(&zero, 1);
    uint8_t lenBytes[8];
    for (int i = 0; i < 8; i++)
        lenBytes[i] = (uint8_t) (messageBits >> (56 - 8 * i));
    update(lenBytes, 8); // completes the final 64-byte block
    for (int i = 0; i < 8; i++) {
        out[i * 4] = (uint8_t) (state_[i] >> 24);
        out[i * 4 + 1] = (uint8_t) (state_[i] >> 16);
        out[i * 4 + 2] = (uint8_t) (state_[i] >> 8);
        out[i * 4 + 3] = (uint8_t) state_[i];
    }
}

std::string sha256Hex(const std::string& data) {
    Sha256 h;
    h.update(data.data(), data.size());
    uint8_t digest[32];
    h.finish(digest);
    return toHex(digest, 32);
}

void hmacSha256(const std::string& key, const std::string& message, uint8_t out[32]) {
    uint8_t keyBlock[64];
    std::memset(keyBlock, 0, sizeof(keyBlock));
    if (key.size() > 64) {
        Sha256 kh;
        kh.update(key.data(), key.size());
        uint8_t kd[32];
        kh.finish(kd);
        std::memcpy(keyBlock, kd, 32);
    }
    else {
        std::memcpy(keyBlock, key.data(), key.size());
    }
    uint8_t ipad[64], opad[64];
    for (int i = 0; i < 64; i++) {
        ipad[i] = keyBlock[i] ^ 0x36;
        opad[i] = keyBlock[i] ^ 0x5c;
    }
    Sha256 inner;
    inner.update(ipad, 64);
    inner.update(message.data(), message.size());
    uint8_t innerDigest[32];
    inner.finish(innerDigest);
    Sha256 outer;
    outer.update(opad, 64);
    outer.update(innerDigest, 32);
    outer.finish(out);
}

std::string hmacSha256Hex(const std::string& key, const std::string& message) {
    uint8_t out[32];
    hmacSha256(key, message, out);
    return toHex(out, 32);
}

bool constantTimeEqual(const std::string& a, const std::string& b) {
    if (a.size() != b.size())
        return false;
    volatile uint8_t acc = 0;
    for (size_t i = 0; i < a.size(); i++)
        acc |= (uint8_t) (a[i] ^ b[i]);
    return acc == 0;
}

std::string toHex(const uint8_t* data, size_t len) {
    static const char* digits = "0123456789abcdef";
    std::string out;
    out.reserve(len * 2);
    for (size_t i = 0; i < len; i++) {
        out.push_back(digits[data[i] >> 4]);
        out.push_back(digits[data[i] & 0xf]);
    }
    return out;
}

static int hexVal(char c) {
    if (c >= '0' && c <= '9')
        return c - '0';
    if (c >= 'a' && c <= 'f')
        return c - 'a' + 10;
    if (c >= 'A' && c <= 'F')
        return c - 'A' + 10;
    return -1;
}

bool fromHex(const std::string& hex, std::string& out) {
    if (hex.size() % 2 != 0)
        return false;
    out.clear();
    out.reserve(hex.size() / 2);
    for (size_t i = 0; i < hex.size(); i += 2) {
        int hi = hexVal(hex[i]);
        int lo = hexVal(hex[i + 1]);
        if (hi < 0 || lo < 0)
            return false;
        out.push_back((char) ((hi << 4) | lo));
    }
    return true;
}

bool randomBytes(uint8_t* out, size_t len) {
#if defined(_WIN32)
    return BCryptGenRandom(NULL, out, (ULONG) len, BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0;
#else
    int fd = open("/dev/urandom", O_RDONLY);
    if (fd < 0)
        return false;
    size_t got = 0;
    while (got < len) {
        ssize_t n = read(fd, out + got, len - got);
        if (n <= 0) {
            close(fd);
            return false;
        }
        got += (size_t) n;
    }
    close(fd);
    return true;
#endif
}

std::string randomHex(size_t nBytes) {
    std::string raw(nBytes, '\0');
    if (!randomBytes((uint8_t*) &raw[0], nBytes))
        return std::string();
    return toHex((const uint8_t*) raw.data(), raw.size());
}

} // namespace rackmcp
