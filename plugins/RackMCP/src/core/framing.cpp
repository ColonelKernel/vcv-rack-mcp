#include "core/framing.hpp"

#include <cstring>

namespace rackmcp {

bool encodeFrame(const std::string& payload, size_t maxFrameBytes, std::string& out) {
    if (payload.size() > maxFrameBytes)
        return false;
    uint32_t n = (uint32_t) payload.size();
    out.clear();
    out.reserve(payload.size() + 4);
    char header[4];
    header[0] = (char) ((n >> 24) & 0xff);
    header[1] = (char) ((n >> 16) & 0xff);
    header[2] = (char) ((n >> 8) & 0xff);
    header[3] = (char) (n & 0xff);
    out.append(header, 4);
    out.append(payload);
    return true;
}

FrameDecoder::FrameDecoder(size_t maxFrameBytes) : maxFrameBytes_(maxFrameBytes) {}

bool FrameDecoder::push(const uint8_t* data, size_t len) {
    if (error_)
        return false;
    // Memory bound. Contract: the caller drains all complete frames with
    // next() after every push, and reads at most maxFrameBytes per chunk.
    // Under that contract the undrained residue never exceeds one incomplete
    // frame (maxFrameBytes + 4), so total growth is capped at twice that.
    // Exceeding the cap means a protocol violation or a misbehaving caller.
    if (buffered() + len > 2 * (maxFrameBytes_ + 4)) {
        error_ = true;
        return false;
    }
    buffer_.append((const char*) data, len);
    return true;
}

bool FrameDecoder::push(const std::string& bytes) {
    return push((const uint8_t*) bytes.data(), bytes.size());
}

bool FrameDecoder::next(std::string& frame) {
    if (error_)
        return false;
    size_t avail = buffer_.size() - consumed_;
    if (avail < 4)
        return false;
    const uint8_t* p = (const uint8_t*) buffer_.data() + consumed_;
    uint32_t n = ((uint32_t) p[0] << 24) | ((uint32_t) p[1] << 16) | ((uint32_t) p[2] << 8) | (uint32_t) p[3];
    if ((size_t) n > maxFrameBytes_) {
        error_ = true;
        return false;
    }
    if (avail < 4 + (size_t) n)
        return false;
    frame.assign(buffer_.data() + consumed_ + 4, n);
    consumed_ += 4 + (size_t) n;
    compact();
    return true;
}

void FrameDecoder::compact() {
    if (consumed_ == 0)
        return;
    if (consumed_ == buffer_.size()) {
        buffer_.clear();
        consumed_ = 0;
        return;
    }
    // Compact when at least half the buffer is dead space.
    if (consumed_ >= buffer_.size() / 2) {
        buffer_.erase(0, consumed_);
        consumed_ = 0;
    }
}

} // namespace rackmcp
