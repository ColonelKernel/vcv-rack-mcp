#include "rackside/Handlers.hpp"

#include <rack.hpp>

#include <jansson.h>

#include "core/frames.hpp"
#include "gen/rackmcp_protocol_gen.hpp"
#include "plugin.hpp"
#include "rackside/RackBridge.hpp"

namespace rackmcp {

// ---------------------------------------------------------------------------
// Handlers (UI thread). Later phases extend this dispatch table.
// ---------------------------------------------------------------------------

static std::string handleStatusGet(const BridgeCommand& cmd) {
    RackBridge& bridge = RackBridge::instance();
    UiStateCache state = bridge.uiState();

    LeaseHolder lease = bridge.server().leases().holder(steadyNowMs());
    json_t* leaseJ;
    if (lease.held) {
        leaseJ = json_pack("{s:b, s:s, s:s, s:I}", "held", 1, "holderClientName",
                           lease.clientName.c_str(), "leaseId", lease.leaseId.c_str(), "expiresInMs",
                           (json_int_t) (lease.expiresAtMs - steadyNowMs()));
    }
    else {
        leaseJ = json_pack("{s:b}", "held", 0);
    }

    float sampleRate = APP->engine ? APP->engine->getSampleRate() : 0.f;
    json_t* payload = json_pack(
        "{s:s, s:s, s:i, s:s, s:s, s:s, s:i, s:s, s:f, s:o, s:b, s:b, s:b, s:o}",
        "instanceId", bridge.instanceId().c_str(),
        "sessionId", bridge.sessionId().c_str(),
        "patchEpoch", bridge.patchEpoch(),
        "rackVersion", bridge.rackVersion().c_str(),
        "rackEdition", bridge.rackEdition().c_str(),
        "bridgeVersion", RACKMCP_BRIDGE_VERSION,
        "bridgeProtocolVersion", gen::BRIDGE_PROTOCOL_VERSION,
        "mode", "standalone-gui",
        "sampleRate", (double) sampleRate,
        "patchName", state.patchName.empty() ? json_null() : json_string(state.patchName.c_str()),
        "saved", state.saved ? 1 : 0,
        "bridgeModulePresent", state.bridgeModulePresent ? 1 : 0,
        "commandPumpPresent", state.commandPumpPresent ? 1 : 0,
        "writerLease", leaseJ);
    return buildResOk(cmd.requestId, payload);
}

static std::string handleMetricsGet(const BridgeCommand& cmd) {
    RackBridge& bridge = RackBridge::instance();
    ServiceCounters& c = bridge.server().counters();
    json_t* payload = json_pack(
        "{s:I, s:I, s:I, s:I, s:I, s:I, s:I, s:I, s:f, s:f, s:f}",
        "commandQueueDepth", (json_int_t) bridge.commandQueue().size(),
        "commandQueueMaxDepth", (json_int_t) bridge.commandQueue().maxDepth(),
        "requestsHandled", (json_int_t) (c.requestsInline.load() + c.requestsEnqueued.load()),
        "requestTimeouts", (json_int_t) 0,
        "rollbacks", (json_int_t) 0,
        "authFailures", (json_int_t) c.authFailures.load(),
        "droppedTelemetryFrames", (json_int_t) 0,
        "bridgeReconnects", (json_int_t) c.connectionsAccepted.load(),
        "uiPumpLastDrainMs", (double) bridge.pumpLastDrainMs.load(),
        "uiPumpMaxDrainMs", (double) bridge.pumpMaxDrainMs.load(),
        "requestLatencyEwmaMs", 0.0);
    return buildResOk(cmd.requestId, payload);
}

/**
 * Handler result. `cacheable` marks results that must be replayed on retries
 * with the same operation id: successful mutations, and failures where the
 * mutation may have occurred (indeterminate rollback). Clean pre-mutation
 * failures are NOT cached, so a corrected retry can execute.
 */
struct HandlerResult {
    std::string frame;
    bool cacheable = false;
};

std::string executeCommand(const BridgeCommand& cmd) {
    // Idempotency: replay cached mutation results by operation id.
    RackBridge& bridge = RackBridge::instance();
    if (!cmd.operationId.empty()) {
        std::string cached;
        if (bridge.lookupOperation(cmd.operationId, cached)) {
            // Rewrite the request id and flag the payload as a replay; the
            // frame schema is strict, so the flag lives inside the payload.
            json_error_t err;
            json_t* root = json_loads(cached.c_str(), 0, &err);
            if (root) {
                json_object_set_new(root, "id", json_string(cmd.requestId.c_str()));
                json_t* payload = json_object_get(root, "payload");
                if (json_is_object(payload))
                    json_object_set_new(payload, "replayed", json_true());
                char* s = json_dumps(root, JSON_COMPACT);
                std::string out = s ? s : cached;
                if (s)
                    free(s);
                json_decref(root);
                return out;
            }
            return cached;
        }
    }

    HandlerResult result;
    if (cmd.method == "status.get")
        result.frame = handleStatusGet(cmd);
    else if (cmd.method == "metrics.get")
        result.frame = handleMetricsGet(cmd);
    else
        result.frame = buildResError(cmd.requestId, "UNSUPPORTED_OPERATION",
                                     "method not implemented in this bridge phase: " + cmd.method,
                                     false, false);

    if (!cmd.operationId.empty() && result.cacheable)
        bridge.recordOperation(cmd.operationId, result.frame);
    return result.frame;
}

} // namespace rackmcp
