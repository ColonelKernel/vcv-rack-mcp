#include "core/frames.hpp"

#include <chrono>
#include <jansson.h>

namespace rackmcp {

static std::string dumpAndFree(json_t* o) {
    char* s = json_dumps(o, JSON_COMPACT);
    std::string out = s ? s : "";
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
    return dumpAndFree(o);
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
    return dumpAndFree(o);
}

std::string buildPong(const std::string& id) {
    json_t* o = json_pack("{s:s, s:s}", "kind", "pong", "id", id.c_str());
    return dumpAndFree(o);
}

std::string buildEvent(const char* event) {
    json_t* o = json_pack("{s:s, s:s}", "kind", "evt", "event", event);
    return dumpAndFree(o);
}

std::string buildResOk(const std::string& id, json_t* payload) {
    if (!payload)
        payload = json_object();
    json_t* o = json_pack("{s:s, s:s, s:b, s:o}",
                          "kind", "res", "id", id.c_str(), "ok", 1, "payload", payload);
    return dumpAndFree(o);
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
    return dumpAndFree(o);
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

} // namespace rackmcp
