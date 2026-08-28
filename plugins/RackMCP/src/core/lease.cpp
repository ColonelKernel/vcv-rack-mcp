#include "core/lease.hpp"
#include "core/uuid.hpp"

namespace rackmcp {

LeaseManager::AcquireResult LeaseManager::acquire(uint64_t connectionId,
                                                  const std::string& clientName, int64_t nowMs,
                                                  int64_t ttlMs, std::string& leaseIdOut) {
    std::lock_guard<std::mutex> lock(mutex_);
    bool expired = holder_.held && nowMs >= holder_.expiresAtMs;
    if (holder_.held && !expired && holder_.connectionId != connectionId)
        return AcquireResult::HeldByOther;
    if (holder_.held && !expired && holder_.connectionId == connectionId) {
        holder_.expiresAtMs = nowMs + ttlMs;
        leaseIdOut = holder_.leaseId;
        return AcquireResult::Ok;
    }
    holder_.held = true;
    holder_.leaseId = uuid4();
    holder_.clientName = clientName;
    holder_.connectionId = connectionId;
    holder_.expiresAtMs = nowMs + ttlMs;
    leaseIdOut = holder_.leaseId;
    return AcquireResult::Ok;
}

bool LeaseManager::renew(uint64_t connectionId, const std::string& leaseId, int64_t nowMs,
                         int64_t ttlMs) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!holder_.held || holder_.connectionId != connectionId || holder_.leaseId != leaseId)
        return false;
    if (nowMs >= holder_.expiresAtMs)
        return false;
    holder_.expiresAtMs = nowMs + ttlMs;
    return true;
}

bool LeaseManager::release(uint64_t connectionId, const std::string& leaseId) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!holder_.held || holder_.connectionId != connectionId || holder_.leaseId != leaseId)
        return false;
    holder_ = LeaseHolder();
    return true;
}

void LeaseManager::onDisconnect(uint64_t connectionId) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (holder_.held && holder_.connectionId == connectionId)
        holder_ = LeaseHolder();
}

bool LeaseManager::isWriter(uint64_t connectionId, int64_t nowMs) const {
    std::lock_guard<std::mutex> lock(mutex_);
    return holder_.held && holder_.connectionId == connectionId && nowMs < holder_.expiresAtMs;
}

LeaseHolder LeaseManager::holder(int64_t nowMs) const {
    std::lock_guard<std::mutex> lock(mutex_);
    LeaseHolder h = holder_;
    if (h.held && nowMs >= h.expiresAtMs)
        h.held = false;
    return h;
}

} // namespace rackmcp
