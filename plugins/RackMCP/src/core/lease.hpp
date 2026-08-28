#pragma once
// Single writer lease per Rack instance. Thread-safe. No Rack dependencies.
#include <cstdint>
#include <mutex>
#include <string>

namespace rackmcp {

struct LeaseHolder {
    bool held = false;
    std::string leaseId;
    std::string clientName;
    uint64_t connectionId = 0;
    int64_t expiresAtMs = 0;
};

class LeaseManager {
public:
    enum class AcquireResult { Ok, HeldByOther };

    /** Re-acquiring from the same connection refreshes and returns the same lease. */
    AcquireResult acquire(uint64_t connectionId, const std::string& clientName, int64_t nowMs,
                          int64_t ttlMs, std::string& leaseIdOut);
    bool renew(uint64_t connectionId, const std::string& leaseId, int64_t nowMs, int64_t ttlMs);
    bool release(uint64_t connectionId, const std::string& leaseId);
    /** Releases any lease held by a disconnecting connection. */
    void onDisconnect(uint64_t connectionId);
    /** True when this connection holds a currently valid lease. */
    bool isWriter(uint64_t connectionId, int64_t nowMs) const;
    LeaseHolder holder(int64_t nowMs) const;

private:
    mutable std::mutex mutex_;
    LeaseHolder holder_;
};

} // namespace rackmcp
