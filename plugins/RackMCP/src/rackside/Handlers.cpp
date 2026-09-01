#include "rackside/Handlers.hpp"

#include <rack.hpp>

#include <cstdlib>
#include <jansson.h>

#include "core/frames.hpp"
#include "gen/rackmcp_protocol_gen.hpp"
#include "rackmcp_plugin.hpp"
#include "rackside/RackBridge.hpp"
#include "rackside/Snapshot.hpp"
#include "rackside/PatchFiles.hpp"
#include "rackside/Transaction.hpp"

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

static int64_t parseDecId(json_t* obj, const char* key, bool& ok) {
    ok = false;
    json_t* v = obj ? json_object_get(obj, key) : NULL;
    if (!json_is_string(v))
        return -1;
    const char* s = json_string_value(v);
    if (!s || !*s)
        return -1;
    char* endp = NULL;
    long long id = strtoll(s, &endp, 10);
    if (endp && *endp == '\0' && id >= 0) {
        ok = true;
        return (int64_t) id;
    }
    return -1;
}

static bool getBoolField(json_t* obj, const char* key, bool dflt) {
    json_t* v = obj ? json_object_get(obj, key) : NULL;
    if (json_is_boolean(v))
        return json_is_true(v);
    return dflt;
}

/** Enforces the client-supplied epoch guard when present. */
static bool epochGuardOk(json_t* payload, std::string& frameOut, const BridgeCommand& cmd) {
    json_t* v = payload ? json_object_get(payload, "expectedPatchEpoch") : NULL;
    if (json_is_integer(v)) {
        int expected = (int) json_integer_value(v);
        if (expected != RackBridge::instance().patchEpoch()) {
            frameOut = buildResError(cmd.requestId, "STALE_PATCH_EPOCH",
                                     "patch epoch changed; re-read the snapshot", true, false);
            return false;
        }
    }
    return true;
}

static std::string handlePatchSnapshot(const BridgeCommand& cmd) {
    std::string err;
    if (!epochGuardOk(cmd.payload, err, cmd))
        return err;
    bool opaque = getBoolField(cmd.payload, "includeOpaqueState", false);
    json_t* snap = buildPatchSnapshot(opaque);
    return buildResOk(cmd.requestId, snap);
}

static std::string handleModuleInspect(const BridgeCommand& cmd) {
    std::string err;
    if (!epochGuardOk(cmd.payload, err, cmd))
        return err;
    bool ok = false;
    int64_t id = parseDecId(cmd.payload, "moduleId", ok);
    if (!ok)
        return buildResError(cmd.requestId, "MODULE_NOT_FOUND", "invalid moduleId", false, false);
    bool opaque = getBoolField(cmd.payload, "includeOpaqueState", false);
    json_t* snap = buildModuleSnapshot(id, opaque);
    if (!snap)
        return buildResError(cmd.requestId, "MODULE_NOT_FOUND",
                             "no module with id " + std::to_string(id), false, false);
    json_t* payload = json_object();
    json_object_set_new(payload, "module", snap);
    return buildResOk(cmd.requestId, payload);
}

static std::string handleCatalogList(const BridgeCommand& cmd) {
    json_t* p = cmd.payload;
    std::string cursor, query;
    int limit = 100;
    if (p) {
        json_t* c = json_object_get(p, "cursor");
        if (json_is_string(c))
            cursor = json_string_value(c);
        json_t* q = json_object_get(p, "query");
        if (json_is_string(q))
            query = json_string_value(q);
        json_t* l = json_object_get(p, "limit");
        if (json_is_integer(l))
            limit = (int) json_integer_value(l);
    }
    if (limit < 1)
        limit = 1;
    if (limit > 500)
        limit = 500;
    json_t* catalog = buildModelCatalog(cursor, limit, query);
    return buildResOk(cmd.requestId, catalog);
}

static std::string handlePatchFingerprint(const BridgeCommand& cmd) {
    std::string err;
    if (!epochGuardOk(cmd.payload, err, cmd))
        return err;
    json_t* payload = json_object();
    json_object_set_new(payload, "fingerprint", json_string(computePatchFingerprint().c_str()));
    json_object_set_new(payload, "patchEpoch", json_integer(RackBridge::instance().patchEpoch()));
    return buildResOk(cmd.requestId, payload);
}

static std::string handleModelInspect(const BridgeCommand& cmd) {
    json_t* p = cmd.payload;
    json_t* psJ = p ? json_object_get(p, "pluginSlug") : NULL;
    json_t* msJ = p ? json_object_get(p, "modelSlug") : NULL;
    if (!json_is_string(psJ) || !json_is_string(msJ))
        return buildResError(cmd.requestId, "MODEL_NOT_INSTALLED", "pluginSlug/modelSlug required",
                             false, false);
    std::string errorCode;
    json_t* meta = inspectModelMetadata(json_string_value(psJ), json_string_value(msJ), errorCode);
    if (!meta)
        return buildResError(cmd.requestId, errorCode.c_str(), "model metadata unavailable", false,
                             false);
    return buildResOk(cmd.requestId, meta);
}


/** Bridges a TxnOutcome to a response frame; caller supplies cacheability. */
static std::string txnOutcomeToFrame(const BridgeCommand& cmd, TxnOutcome& outcome) {
    if (!outcome.errorCode.empty()) {
        std::string frame = buildResError(cmd.requestId, outcome.errorCode.c_str(),
                                          outcome.errorMessage, outcome.retrySafe,
                                          outcome.mutationMayHaveOccurred);
        if (outcome.payload)
            json_decref(outcome.payload);
        return frame;
    }
    return buildResOk(cmd.requestId, outcome.payload);
}

static std::string handleTxnPreview(const BridgeCommand& cmd) {
    TxnOutcome outcome = txnPreview(cmd.payload);
    return txnOutcomeToFrame(cmd, outcome);
}

static std::string handleTxnCommit(const BridgeCommand& cmd, bool& cacheable) {
    TxnOutcome outcome = txnCommit(cmd.payload);
    // Cache successful commits and indeterminate-rollback failures by op id so
    // retries replay rather than reapply.
    cacheable = outcome.errorCode.empty() || outcome.mutationMayHaveOccurred;
    return txnOutcomeToFrame(cmd, outcome);
}

static std::string handleTxnUndo(const BridgeCommand& cmd, bool& cacheable) {
    TxnOutcome outcome = txnUndoLast(cmd.payload);
    cacheable = outcome.errorCode.empty();
    return txnOutcomeToFrame(cmd, outcome);
}


static std::string patchFileOutcomeToFrame(const BridgeCommand& cmd, PatchFileOutcome& o) {
    if (!o.errorCode.empty()) {
        std::string frame = buildResError(cmd.requestId, o.errorCode.c_str(), o.errorMessage, false,
                                          o.errorCode == "INTERNAL");
        if (o.payload)
            json_decref(o.payload);
        return frame;
    }
    return buildResOk(cmd.requestId, o.payload);
}

static std::string handlePatchSave(const BridgeCommand& cmd, bool& cacheable) {
    PatchFileOutcome o = patchSave(cmd.payload);
    cacheable = o.errorCode.empty();
    return patchFileOutcomeToFrame(cmd, o);
}
static std::string handlePatchSaveCopy(const BridgeCommand& cmd, bool& cacheable) {
    PatchFileOutcome o = patchSaveCopy(cmd.payload);
    cacheable = o.errorCode.empty();
    return patchFileOutcomeToFrame(cmd, o);
}
static std::string handlePatchLoad(const BridgeCommand& cmd, bool& cacheable) {
    PatchFileOutcome o = patchLoad(cmd.payload);
    cacheable = o.errorCode.empty();
    return patchFileOutcomeToFrame(cmd, o);
}
static std::string handlePatchClear(const BridgeCommand& cmd, bool& cacheable) {
    PatchFileOutcome o = patchClear(cmd.payload);
    cacheable = o.errorCode.empty();
    return patchFileOutcomeToFrame(cmd, o);
}

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
    else if (cmd.method == "patch.snapshot")
        result.frame = handlePatchSnapshot(cmd);
    else if (cmd.method == "module.inspect")
        result.frame = handleModuleInspect(cmd);
    else if (cmd.method == "catalog.listModels")
        result.frame = handleCatalogList(cmd);
    else if (cmd.method == "catalog.inspectModel")
        result.frame = handleModelInspect(cmd);
    else if (cmd.method == "patch.fingerprint")
        result.frame = handlePatchFingerprint(cmd);
    else if (cmd.method == "txn.preview")
        result.frame = handleTxnPreview(cmd);
    else if (cmd.method == "txn.commit")
        result.frame = handleTxnCommit(cmd, result.cacheable);
    else if (cmd.method == "txn.undoLast")
        result.frame = handleTxnUndo(cmd, result.cacheable);
    else if (cmd.method == "patchfile.save")
        result.frame = handlePatchSave(cmd, result.cacheable);
    else if (cmd.method == "patchfile.saveCopy")
        result.frame = handlePatchSaveCopy(cmd, result.cacheable);
    else if (cmd.method == "patchfile.load")
        result.frame = handlePatchLoad(cmd, result.cacheable);
    else if (cmd.method == "patchfile.clear")
        result.frame = handlePatchClear(cmd, result.cacheable);
    else
        result.frame = buildResError(cmd.requestId, "UNSUPPORTED_OPERATION",
                                     "method not implemented in this bridge phase: " + cmd.method,
                                     false, false);

    if (!cmd.operationId.empty() && result.cacheable)
        bridge.recordOperation(cmd.operationId, result.frame);
    return result.frame;
}

} // namespace rackmcp
