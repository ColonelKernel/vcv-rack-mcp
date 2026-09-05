#include "core/frames.hpp"

#include <chrono>
#include <cstdio>
#include <jansson.h>

namespace rackmcp {

// A failed json_pack (jansson rejects e.g. a string that is not valid UTF-8) or
// a failed json_dumps must never turn into a 0-length frame: the client parses
// every frame as JSON and tears the whole session down on a parse error. Every
// builder therefore names a fixed, always-valid fallback frame. An empty result
// means "no frame at all"; callers must drop it rather than put it on the wire.
static const char* const kAuthResultInternal =
    "{\"kind\":\"authResult\",\"ok\":false,\"error\":{\"code\":\"INTERNAL\","
    "\"message\":\"frame encoding failed\",\"retrySafe\":false,"
    "\"mutationMayHaveOccurred\":false}}";

/** Request ids are 16 hex chars on the wire; only inline ids known to be safe. */
static bool isSafeId(const std::string& id) {
    if (id.empty() || id.size() > 64)
        return false;
    for (size_t i = 0; i < id.size(); i++) {
        char c = id[i];
        bool ok = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                  c == '-' || c == '_';
        if (!ok)
            return false;
    }
    return true;
}

/** Hand-built so it cannot itself fail to encode. Empty when the id is unusable. */
static std::string resInternalError(const std::string& id, bool mutationMayHaveOccurred) {
    if (!isSafeId(id))
        return std::string();
    return "{\"kind\":\"res\",\"id\":\"" + id +
           "\",\"ok\":false,\"error\":{\"code\":\"INTERNAL\",\"message\":\"response encoding "
           "failed\",\"retrySafe\":false,\"mutationMayHaveOccurred\":" +
           (mutationMayHaveOccurred ? "true" : "false") + "}}";
}

static std::string dumpAndFree(json_t* o, const std::string& fallback) {
    char* s = json_dumps(o, JSON_COMPACT); // json_dumps(NULL) returns NULL
    std::string out = s ? s : fallback;
    if (s)
        free(s);
    json_decref(o);
    return out;
}

std::string buildWelcome(const WelcomeInfo& info) {
    json_t* o = json_pack("{s:s, s:i, s:s, s:s, s:s, s:s, s:s, s:i, s:s, s:b}",
                          "kind", "welcome",
                          "version", info.version,
                          "instanceId", info.instanceId.c_str(),
                          "sessionId", info.sessionId.c_str(),
                          "bridgeVersion", info.bridgeVersion.c_str(),
                          "rackVersion", info.rackVersion.c_str(),
                          "rackEdition", info.rackEdition.c_str(),
                          "patchEpoch", info.patchEpoch,
                          "nonce", info.nonce.c_str(),
                          "authRequired", 1);
    // A welcome that cannot be encoded aborts the handshake with an error the
    // client can actually parse.
    return dumpAndFree(o, kAuthResultInternal);
}

std::string buildAuthResult(bool ok, const char* errorCode, const char* message) {
    json_t* o;
    if (ok) {
        o = json_pack("{s:s, s:b, s:s}", "kind", "authResult", "ok", 1, "role", "readonly");
    }
    else {
        o = json_pack("{s:s, s:b, s:{s:s, s:s, s:b, s:b}}",
                      "kind", "authResult", "ok", 0,
                      "error",
                      "code", errorCode,
                      "message", message,
                      "retrySafe", 0,
                      "mutationMayHaveOccurred", 0);
    }
    return dumpAndFree(o, kAuthResultInternal);
}

std::string buildPong(const std::string& id) {
    json_t* o = json_pack("{s:s, s:s}", "kind", "pong", "id", id.c_str());
    // Nothing useful to say instead of a pong; an unsent one just lapses.
    return dumpAndFree(o, std::string());
}

std::string buildEvent(const char* event) {
    json_t* o = json_pack("{s:s, s:s}", "kind", "evt", "event", event);
    return dumpAndFree(o, std::string());
}

std::string buildResOk(const std::string& id, json_t* payload) {
    if (!payload)
        payload = json_object();
    // Build the envelope first, then attach the payload: json_object_set_new
    // consumes the reference on every path, so the payload has exactly one
    // owner even when packing fails. The fallback says the mutation may have
    // occurred because the command did run; only its result was lost.
    json_t* o = json_pack("{s:s, s:s, s:b}", "kind", "res", "id", id.c_str(), "ok", 1);
    if (!o) {
        json_decref(payload);
        return resInternalError(id, true);
    }
    if (json_object_set_new(o, "payload", payload) != 0) {
        json_decref(o);
        return resInternalError(id, true);
    }
    return dumpAndFree(o, resInternalError(id, true));
}

std::string buildResError(const std::string& id, const char* code, const std::string& message,
                          bool retrySafe, bool mutationMayHaveOccurred) {
    json_t* o = json_pack("{s:s, s:s, s:b, s:{s:s, s:s, s:b, s:b}}",
                          "kind", "res", "id", id.c_str(), "ok", 0,
                          "error",
                          "code", code,
                          "message", message.c_str(),
                          "retrySafe", retrySafe ? 1 : 0,
                          "mutationMayHaveOccurred", mutationMayHaveOccurred ? 1 : 0);
    return dumpAndFree(o, resInternalError(id, mutationMayHaveOccurred));
}

std::string capResponseFrame(const std::string& frame, const std::string& id,
                             const std::string& method, size_t maxFrameBytes, bool mutating) {
    if (frame.size() <= maxFrameBytes)
        return frame;
    // Method names come from the generated method table, so they are short and
    // ASCII; clamp anyway so the substitute can never itself exceed the cap.
    std::string m = method.substr(0, 64);
    char sizes[128];
    std::snprintf(sizes, sizeof(sizes), " result is %llu bytes, over the %llu-byte bridge frame limit",
                  (unsigned long long) frame.size(), (unsigned long long) maxFrameBytes);
    return buildResError(id, "RESULT_TOO_LARGE", m + sizes, false, mutating);
}

std::string authMessage(const std::string& nonce, const std::string& instanceId,
                        const std::string& sessionId) {
    return nonce + "|" + instanceId + "|" + sessionId;
}

int64_t steadyNowMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::steady_clock::now().time_since_epoch())
        .count();
}

int64_t steadyNowUs() {
    return std::chrono::duration_cast<std::chrono::microseconds>(
               std::chrono::steady_clock::now().time_since_epoch())
        .count();
}

} // namespace rackmcp
