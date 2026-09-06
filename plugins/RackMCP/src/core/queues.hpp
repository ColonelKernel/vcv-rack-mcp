#pragma once
// Bounded queues for the RackMCP bridge. No Rack dependencies; C++11.
//
// - BoundedQueue<T>: mutex + condvar MPMC queue used between network threads
//   and the UI command pump. Never used from Module::process().
// - TelemetrySnapshotBuffer<T>: lock-free single-writer / multi-reader
//   double buffer (seqlock) for POD telemetry snapshots published by DSP.
#include <cstddef>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <mutex>

#include <atomic>
#include <cstring>

namespace rackmcp {

template <typename T>
class BoundedQueue {
public:
    explicit BoundedQueue(size_t capacity) : capacity_(capacity) {}

    /** Non-blocking. Returns false when full or closed. */
    bool tryPush(T value) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (closed_ || items_.size() >= capacity_)
            return false;
        items_.push_back(static_cast<T&&>(value));
        if (items_.size() > maxDepth_)
            maxDepth_ = items_.size();
        cv_.notify_one();
        return true;
    }

    /** Non-blocking. Returns false when empty. */
    bool tryPop(T& out) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (items_.empty())
            return false;
        out = static_cast<T&&>(items_.front());
        items_.pop_front();
        return true;
    }

    /** Blocks up to timeoutMs for an item. Returns false on timeout or close-and-empty. */
    bool popWait(T& out, int64_t timeoutMs) {
        std::unique_lock<std::mutex> lock(mutex_);
        if (!cv_.wait_for(lock, std::chrono::milliseconds(timeoutMs),
                          [this] { return closed_ || !items_.empty(); }))
            return false;
        if (items_.empty())
            return false;
        out = static_cast<T&&>(items_.front());
        items_.pop_front();
        return true;
    }

    /** Wakes all waiters; subsequent pushes fail. Existing items remain poppable. */
    void close() {
        std::lock_guard<std::mutex> lock(mutex_);
        closed_ = true;
        cv_.notify_all();
    }

    bool closed() const {
        std::lock_guard<std::mutex> lock(mutex_);
        return closed_;
    }

    size_t size() const {
        std::lock_guard<std::mutex> lock(mutex_);
        return items_.size();
    }

    size_t maxDepth() const {
        std::lock_guard<std::mutex> lock(mutex_);
        return maxDepth_;
    }

private:
    size_t capacity_;
    mutable std::mutex mutex_;
    std::condition_variable cv_;
    std::deque<T> items_;
    size_t maxDepth_ = 0;
    bool closed_ = false;
};

/**
 * Seqlock double buffer for a trivially copyable snapshot T.
 * publish() is wait-free and allocation-free (DSP side).
 * read() retries until it observes a consistent snapshot (UI/network side).
 */
template <typename T>
class TelemetrySnapshotBuffer {
public:
    TelemetrySnapshotBuffer() : seq_(0) {
        std::memset(&slots_[0], 0, sizeof(T));
        std::memset(&slots_[1], 0, sizeof(T));
    }

    /** Called only from the single writer (DSP thread). Wait-free, no locks. */
    void publish(const T& value) {
        uint32_t s = seq_.load(std::memory_order_relaxed);
        seq_.store(s + 1, std::memory_order_relaxed); // odd: write in progress
        // Full fence: the odd marker must be visible before the data write,
        // and the data write must complete before the even marker.
        std::atomic_thread_fence(std::memory_order_seq_cst);
        slots_[(s / 2 + 1) % 2] = value;
        std::atomic_thread_fence(std::memory_order_release);
        seq_.store(s + 2, std::memory_order_release); // even: stable
    }

    /** Returns false when nothing has been published yet. */
    bool read(T& out) const {
        for (int attempt = 0; attempt < 1000; attempt++) {
            uint32_t before = seq_.load(std::memory_order_acquire);
            if (before == 0)
                return false;
            if (before % 2 != 0)
                continue;
            out = slots_[(before / 2) % 2];
            std::atomic_thread_fence(std::memory_order_acquire);
            uint32_t after = seq_.load(std::memory_order_acquire);
            if (before == after)
                return true;
        }
        return false;
    }

    /** Number of published snapshots so far. */
    uint32_t sequence() const { return seq_.load(std::memory_order_acquire) / 2; }

private:
    std::atomic<uint32_t> seq_;
    T slots_[2];
};

} // namespace rackmcp
