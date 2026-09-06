#pragma once
// Bounded, thread-safe rings behind the RackMCP-Chat panel: what the assistant
// did, what the user typed back, and what the assistant said.
//
// Rack-free on purpose. Eviction, sequencing and delivery marking are the parts
// that can be wrong in ways nobody notices — a ring that silently drops the
// newest entry instead of the oldest looks fine on a quiet rack — so they are
// testable without a running Rack.
#include <cstddef>
#if RACKMCP_HAVE_JANSSON
#include <jansson.h>
#endif
#include <mutex>
#include <string>
#include <vector>

namespace rackmcp {

/** One bridge method the pump executed, as the panel wants to show it. */
struct ActivityEntry {
    /** Monotonic, never reused, and never reset by eviction. */
    unsigned long long seq = 0;
    /** Bridge method name, untruncated. */
    std::string method;
    /** Empty on success; the error code otherwise. */
    std::string errorCode;
    long long elapsedMs = 0;
    /** Wall-clock hh:mm:ss for display, filled in by the caller. */
    std::string clock;

    bool ok() const { return errorCode.empty(); }
};

/**
 * A message in the conversation between the user and the assistant.
 *
 * `delivered` matters more here than it looks. Nothing the user does inside
 * Rack can wake the assistant: the bridge is request/response with the server
 * as the requester, and the server cannot push to its host either. A note is
 * therefore *queued* until the assistant next calls a tool. Marking that state
 * is the difference between an honest panel and one that looks like a chat box
 * which is merely slow.
 */
struct ChatEntry {
    unsigned long long seq = 0;
    /** True when the user typed it, false when the assistant said it. */
    bool fromUser = true;
    std::string text;
    std::string clock;
    bool delivered = false;
};

/**
 * Fixed-capacity ring that evicts the oldest entry when full.
 *
 * Capacity is a hard bound because this is fed by the command pump on the UI
 * thread: unbounded growth would turn a busy session into a memory leak that
 * only shows up after hours.
 */
template <typename T> class BoundedRing {
public:
    explicit BoundedRing(size_t capacity) : capacity_(capacity ? capacity : 1) {}

    /** Appends, assigning the next sequence number, evicting the oldest if full. */
    unsigned long long push(T entry) {
        std::lock_guard<std::mutex> lock(mutex_);
        entry.seq = ++lastSeq_;
        items_.push_back(entry);
        while (items_.size() > capacity_) {
            items_.erase(items_.begin());
            evicted_++;
        }
        return lastSeq_;
    }

    /** A snapshot of everything currently held, oldest first. */
    std::vector<T> snapshot() const {
        std::lock_guard<std::mutex> lock(mutex_);
        return items_;
    }

    /** Everything with seq > since, oldest first. */
    std::vector<T> since(unsigned long long since) const {
        std::lock_guard<std::mutex> lock(mutex_);
        std::vector<T> out;
        for (const T& item : items_)
            if (item.seq > since)
                out.push_back(item);
        return out;
    }

    /**
     * Marks every entry with seq <= through as delivered, and reports how many
     * changed. Only meaningful for entry types with a `delivered` field.
     */
    size_t markDelivered(unsigned long long through) {
        std::lock_guard<std::mutex> lock(mutex_);
        size_t changed = 0;
        for (T& item : items_) {
            if (item.seq <= through && !item.delivered) {
                item.delivered = true;
                changed++;
            }
        }
        return changed;
    }

    size_t size() const {
        std::lock_guard<std::mutex> lock(mutex_);
        return items_.size();
    }
    size_t capacity() const { return capacity_; }
    /** Entries dropped to stay within capacity, for an honest "..." marker. */
    unsigned long long evicted() const {
        std::lock_guard<std::mutex> lock(mutex_);
        return evicted_;
    }
    unsigned long long lastSeq() const {
        std::lock_guard<std::mutex> lock(mutex_);
        return lastSeq_;
    }

    void clear() {
        std::lock_guard<std::mutex> lock(mutex_);
        items_.clear();
        // lastSeq_ is deliberately not reset: a cursor held by the server must
        // never be satisfied again by a reused sequence number.
    }

private:
    mutable std::mutex mutex_;
    const size_t capacity_;
    std::vector<T> items_;
    unsigned long long lastSeq_ = 0;
    unsigned long long evicted_ = 0;
};

/** Longest note the panel accepts, matching the bridge method's schema bound. */
const size_t CHAT_MAX_TEXT_BYTES = 2000;

/**
 * Trims to at most CHAT_MAX_TEXT_BYTES without splitting a UTF-8 sequence.
 *
 * A cut mid-sequence would put invalid UTF-8 on the wire, and jansson refuses
 * to encode it — turning one overlong note into a frame that cannot be built.
 */
std::string clampChatText(const std::string& text);

/** hh:mm:ss in local time, for the panel's left column. */
std::string clockNow();

/**
 * Builds the `chat.poll` result payload. Caller owns the returned reference.
 *
 * Split out of the handler so the non-empty case can be tested: a note can only
 * be created by typing into the panel, and Rack draws its UI in OpenGL with no
 * accessibility tree, so no script can produce one. Without this the only shape
 * ever exercised would be the empty array — and a wrong json_pack format string
 * returns NULL, which every other test would happily pass over.
 */
#if RACKMCP_HAVE_JANSSON
json_t* buildChatPollPayload(const std::vector<ChatEntry>& notes, unsigned long long lastSeq,
                             unsigned long long dropped);
#endif

} // namespace rackmcp
