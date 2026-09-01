#pragma once
// Plugin-global bridge glue: owns the BridgeServer, the network-to-UI command
// queue, the discovery manifest heartbeat, and the UI-state cache that lets
// non-UI threads report Rack facts without touching Rack APIs.
#include <atomic>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "core/manifest.hpp"
#include "core/queues.hpp"
#include "core/service.hpp"

namespace rackmcp {

/** Rack facts cached by the UI thread for non-UI consumers (manifest, welcome). */
struct UiStateCache {
    std::string patchName;   // empty when unsaved/untitled
    bool saved = false;
    bool bridgeModulePresent = false;
    bool commandPumpPresent = false;
};

class RackBridge : public ServiceCallbacks {
public:
    static RackBridge& instance();

    /** Called from plugin init() on the UI thread. Idempotent. */
    void start();
    /** Deterministic shutdown; safe to call after Rack teardown. Idempotent. */
    void stop();
    bool running() const { return started_.load(); }

    // ServiceCallbacks (session threads)
    bool enqueueCommand(BridgeCommand& cmd) override;
    int currentPatchEpoch() override { return patchEpoch_.load(); }

    // --- UI-thread entry points -------------------------------------------
    /** Pump drains from here. */
    BoundedQueue<BridgeCommand>& commandQueue() { return commandQueue_; }
    BridgeServer& server() { return server_; }

    void publishUiState(const UiStateCache& state);
    UiStateCache uiState();
    /** Lock-free hint for the Bridge module's DSP-side warning light. */
    bool uiStateSavedHint() const { return savedHint_.load(); }

    /** Last executed operation summary, for the Bridge panel display. */
    void setLastOp(const std::string& summary);
    std::string lastOp();

    void bumpPatchEpoch() { patchEpoch_.fetch_add(1); }
    int patchEpoch() const { return patchEpoch_.load(); }

    /** Bridge module bookkeeping (module ctor/dtor, UI thread). */
    void bridgeModuleAdded() { bridgeModuleCount_.fetch_add(1); }
    void bridgeModuleRemoved() { bridgeModuleCount_.fetch_sub(1); }
    int bridgeModuleCount() const { return bridgeModuleCount_.load(); }

    void setPumpAttached(bool attached) { pumpAttached_.store(attached); }
    bool pumpAttached() const { return pumpAttached_.load(); }

    /** Rotates the pairing secret and drops all sessions (Bridge panel control). */
    void resetPairing();

    /** Identity and paths (immutable after start()). */
    const std::string& instanceId() const { return instanceId_; }
    const std::string& sessionId() const { return sessionId_; }
    const std::string& checkpointsDir() const { return checkpointsDir_; }
    const std::string& patchesDir() const { return patchesDir_; }
    const std::string& rackEdition() const { return rackEdition_; }
    const std::string& rackVersion() const { return rackVersion_; }

    /** Pump drain-duration metrics (written by the pump, read by metrics.get). */
    std::atomic<int64_t> pumpLastDrainMs{0};
    std::atomic<int64_t> pumpMaxDrainMs{0};

    /** Pump-side idempotency cache (operationId -> response frame). */
    bool lookupOperation(const std::string& operationId, std::string& frameOut);
    void recordOperation(const std::string& operationId, const std::string& frame);

private:
    RackBridge() = default;
    void heartbeatLoop();
    void writeManifestNow();

    std::atomic<bool> started_{false};
    std::atomic<int> patchEpoch_{1};
    std::atomic<int> bridgeModuleCount_{0};
    std::atomic<bool> pumpAttached_{false};

    BoundedQueue<BridgeCommand> commandQueue_{64};
    BridgeServer server_;

    std::mutex uiStateMutex_;
    UiStateCache uiState_;
    std::atomic<bool> savedHint_{true};
    std::mutex lastOpMutex_;
    std::string lastOp_ = "none";

    std::thread heartbeatThread_;
    std::atomic<bool> stopHeartbeat_{false};

    std::string instanceId_;
    std::string sessionId_;
    std::string secret_;
    std::string rackmcpDir_;
    std::string instancesDir_;
    std::string checkpointsDir_;
    std::string patchesDir_;
    std::string userDir_;
    std::string rackVersion_;
    std::string rackEdition_;
    std::string startTimeIso_;

    // Idempotency cache: bounded FIFO with TTL (spec: >= 10 minutes).
    struct OpEntry {
        std::string operationId;
        std::string frame;
        int64_t storedAtMs;
    };
    std::mutex opCacheMutex_;
    std::vector<OpEntry> opCache_;
};

} // namespace rackmcp
