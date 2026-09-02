#include "rackside/RackBridge.hpp"

#include <rack.hpp>

#include <algorithm>
#include <jansson.h>
#if defined(_WIN32)
#include <windows.h>
#else
#include <unistd.h>
#endif

#include "core/crypto.hpp"
#include "core/frames.hpp"
#include "core/secret.hpp"
#include "core/uuid.hpp"
#include "gen/rackmcp_protocol_gen.hpp"
#include "rackmcp_plugin.hpp"

namespace rackmcp {

RackBridge& RackBridge::instance() {
    static RackBridge bridge;
    return bridge;
}

void RackBridge::start() {
    if (started_.load())
        return;

    userDir_ = rack::asset::userDir;
    rackmcpDir_ = rack::system::join(userDir_, "RackMCP");
    instancesDir_ = rack::system::join(rackmcpDir_, "instances");
    checkpointsDir_ = rack::system::join(rackmcpDir_, "checkpoints");
    patchesDir_ = rack::system::join(userDir_, "patches");
    rackVersion_ = rack::APP_VERSION;
    rackEdition_ = (rack::APP_EDITION == "Pro") ? "Pro" : (rack::APP_EDITION == "Free" ? "Free" : "unknown");

    if (!ensurePrivateDirectory(rackmcpDir_)) {
        WARN("RackMCP: cannot create %s; bridge disabled", rackmcpDir_.c_str());
        return;
    }
    ensurePrivateDirectory(instancesDir_);
    ensurePrivateDirectory(checkpointsDir_);

    bool created = false;
    if (!loadOrCreateSecret(rackmcpDir_, secret_, created)) {
        WARN("RackMCP: cannot create pairing secret; bridge disabled");
        return;
    }
    if (created)
        INFO("RackMCP: generated new pairing secret");

    instanceId_ = uuid4();
    sessionId_ = uuid4();
    startTimeIso_ = isoNowUtc();

    ServiceConfig config;
    config.secret = secret_;
    config.instanceId = instanceId_;
    config.sessionId = sessionId_;
    config.bridgeVersion = RACKMCP_BRIDGE_VERSION;
    config.rackVersion = rackVersion_;
    config.rackEdition = rackEdition_;
    if (!server_.start(config, this)) {
        WARN("RackMCP: bridge server failed to start; bridge disabled");
        return;
    }
    INFO("RackMCP: bridge listening on 127.0.0.1:%d (instance %s)", (int) server_.port(),
         instanceId_.c_str());

    stopHeartbeat_.store(false);
    heartbeatThread_ = std::thread([this] { heartbeatLoop(); });
    started_.store(true);
}

void RackBridge::stop() {
    if (!started_.exchange(false))
        return;
    server_.broadcastEvent(buildEvent("shutting_down"));
    stopHeartbeat_.store(true);
    if (heartbeatThread_.joinable())
        heartbeatThread_.join();
    commandQueue_.close();
    server_.stop();
    removeManifest(instancesDir_, instanceId_);
    // Drop any commands the pump never drained (decref their payloads).
    BridgeCommand cmd;
    while (commandQueue_.tryPop(cmd)) {
        if (cmd.payload)
            json_decref(cmd.payload);
    }
    // Scrub the in-memory secret.
    std::fill(secret_.begin(), secret_.end(), '\0');
    INFO("RackMCP: bridge stopped (threads joined, manifest removed)");
}

bool RackBridge::enqueueCommand(BridgeCommand& cmd) {
    // Without an attached command pump nothing would ever drain the queue;
    // fail fast so the client sees BRIDGE_NOT_READY instead of a timeout.
    if (!pumpAttached_.load())
        return false;
    return commandQueue_.tryPush(cmd);
}

void RackBridge::publishUiState(const UiStateCache& state) {
    {
        std::lock_guard<std::mutex> lock(uiStateMutex_);
        uiState_ = state;
    }
    savedHint_.store(state.saved);
}

void RackBridge::setLastOp(const std::string& summary) {
    std::lock_guard<std::mutex> lock(lastOpMutex_);
    lastOp_ = summary.size() > 24 ? summary.substr(0, 24) : summary;
}

std::string RackBridge::lastOp() {
    std::lock_guard<std::mutex> lock(lastOpMutex_);
    return lastOp_;
}

void RackBridge::setLastMcpTransaction(const std::string& operationId,
                                       const std::string& postFingerprint) {
    std::lock_guard<std::mutex> lock(lastTxnMutex_);
    hasLastTxn_ = true;
    lastTxnOpId_ = operationId;
    lastTxnFingerprint_ = postFingerprint;
}

bool RackBridge::lastMcpTransaction(std::string& operationIdOut, std::string& postFingerprintOut) {
    std::lock_guard<std::mutex> lock(lastTxnMutex_);
    if (!hasLastTxn_)
        return false;
    operationIdOut = lastTxnOpId_;
    postFingerprintOut = lastTxnFingerprint_;
    return true;
}

void RackBridge::clearLastMcpTransaction() {
    std::lock_guard<std::mutex> lock(lastTxnMutex_);
    hasLastTxn_ = false;
    lastTxnOpId_.clear();
    lastTxnFingerprint_.clear();
}

UiStateCache RackBridge::uiState() {
    std::lock_guard<std::mutex> lock(uiStateMutex_);
    return uiState_;
}

void RackBridge::heartbeatLoop() {
    // Heartbeat thread: filesystem + cached state only; never touches Rack APIs.
    while (!stopHeartbeat_.load()) {
        writeManifestNow();
        for (int i = 0; i < 20 && !stopHeartbeat_.load(); i++)
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
}

void RackBridge::writeManifestNow() {
    UiStateCache state = uiState();
    ManifestData d;
    d.instanceId = instanceId_;
#if defined(_WIN32)
    d.pid = (int64_t) GetCurrentProcessId();
#else
    d.pid = (int64_t) getpid();
#endif
    d.rackVersion = rackVersion_;
    d.rackEdition = rackEdition_;
    d.bridgeVersion = RACKMCP_BRIDGE_VERSION;
    d.bridgeProtocolVersion = gen::BRIDGE_PROTOCOL_VERSION;
    d.port = server_.port();
    d.startTimeIso = startTimeIso_;
    d.lastHeartbeatIso = isoNowUtc();
    d.patchName = state.patchName;
    d.commandPumpPresent = state.commandPumpPresent;
    d.bridgeModulePresent = state.bridgeModulePresent;
    d.userDir = userDir_;
    d.patchesDir = patchesDir_;
    d.checkpointsDir = checkpointsDir_;
    writeManifest(instancesDir_, d);
}

void RackBridge::resetPairing() {
    if (!started_.load())
        return;
    std::string fresh;
    if (!rotateSecret(rackmcpDir_, fresh)) {
        WARN("RackMCP: pairing reset failed");
        return;
    }
    INFO("RackMCP: pairing secret rotated; restarting bridge server");
    server_.broadcastEvent(buildEvent("shutting_down"));
    server_.stop();
    secret_ = fresh;
    ServiceConfig config;
    config.secret = secret_;
    config.instanceId = instanceId_;
    config.sessionId = sessionId_;
    config.bridgeVersion = RACKMCP_BRIDGE_VERSION;
    config.rackVersion = rackVersion_;
    config.rackEdition = rackEdition_;
    server_.start(config, this);
    writeManifestNow();
}

bool RackBridge::lookupOperation(const std::string& operationId, std::string& frameOut) {
    std::lock_guard<std::mutex> lock(opCacheMutex_);
    int64_t now = steadyNowMs();
    for (const OpEntry& e : opCache_) {
        if (e.operationId == operationId && now - e.storedAtMs < gen::LIMIT_IDEMPOTENCY_CACHE_MS) {
            frameOut = e.frame;
            return true;
        }
    }
    return false;
}

void RackBridge::recordOperation(const std::string& operationId, const std::string& frame) {
    std::lock_guard<std::mutex> lock(opCacheMutex_);
    int64_t now = steadyNowMs();
    // Evict expired entries; bound total size.
    std::vector<OpEntry> kept;
    kept.reserve(opCache_.size() + 1);
    for (OpEntry& e : opCache_) {
        if (now - e.storedAtMs < gen::LIMIT_IDEMPOTENCY_CACHE_MS)
            kept.push_back(std::move(e));
    }
    opCache_ = std::move(kept);
    if (opCache_.size() >= 512)
        opCache_.erase(opCache_.begin());
    OpEntry entry;
    entry.operationId = operationId;
    entry.frame = frame;
    entry.storedAtMs = now;
    opCache_.push_back(std::move(entry));
}

} // namespace rackmcp
