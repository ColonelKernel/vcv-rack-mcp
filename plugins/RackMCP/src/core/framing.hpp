#pragma once
// Length-prefixed frame codec for the RackMCP bridge protocol.
// Wire format: 4-byte big-endian unsigned length N, followed by N bytes of
// UTF-8 JSON. No Rack dependencies; unit tested and fuzzed out of tree.
#include <cstddef>
#include <cstdint>
#include <string>

namespace rackmcp {

/** Encodes one frame. Returns false when the payload exceeds maxFrameBytes. */
bool encodeFrame(const std::string& payload, size_t maxFrameBytes, std::string& out);

/**
 * Incremental decoder. Feed arbitrary byte chunks with push(); pull complete
 * frames with next(). Once a frame length exceeding maxFrameBytes is seen the
 * decoder enters a permanent error state (the connection must be dropped:
 * resynchronization inside a byte stream is not safe).
 */
class FrameDecoder {
public:
    explicit FrameDecoder(size_t maxFrameBytes);

    /** Returns false when the decoder is in the error state. */
    bool push(const uint8_t* data, size_t len);
    bool push(const std::string& bytes);

    /** Pops the next complete frame payload; returns false when none is ready. */
    bool next(std::string& frame);

    bool error() const { return error_; }
    /** Bytes currently buffered (bounded by maxFrameBytes + 4). */
    size_t buffered() const { return buffer_.size() - consumed_; }

private:
    void compact();

    size_t maxFrameBytes_;
    std::string buffer_;
    size_t consumed_ = 0;
    bool error_ = false;
};

} // namespace rackmcp
