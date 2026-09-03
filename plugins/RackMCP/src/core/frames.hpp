#pragma once
// Builders/parsers for bridge protocol frames (JSON payload level).
// No Rack dependencies (jansson only); C++11; unit tested out of tree.
//
// Every builder is fail-safe: when jansson cannot encode the frame it returns a
// minimal, valid fallback frame, or an empty string meaning "send nothing".
// A builder never returns a non-empty string that is not valid JSON, and
// callers must never put an empty string on the wire (a 0-length frame makes
// the client tear the session down).
#include <cstdint>
#include <string>

typedef struct json_t json_t;

namespace rackmcp {

struct WelcomeInfo {
    int version;
    std::string instanceId;
    std::string sessionId;
    std::string bridgeVersion;
    std::string rackVersion;
    std::string rackEdition; // "Free" | "Pro" | "unknown"
    int patchEpoch;
    std::string nonce; // 64 hex chars
};

std::string buildWelcome(const WelcomeInfo& info);
std::string buildAuthResult(bool ok, const char* errorCode, const char* message);
std::string buildPong(const std::string& id);
std::string buildEvent(const char* event);

/** Successful response; takes ownership of payload (may be NULL for {}). */
std::string buildResOk(const std::string& id, json_t* payload);

/** Error response. */
std::string buildResError(const std::string& id, const char* code, const std::string& message,
                          bool retrySafe, bool mutationMayHaveOccurred);

/** The exact message an authenticating client must HMAC. */
std::string authMessage(const std::string& nonce, const std::string& instanceId,
                        const std::string& sessionId);

/** Monotonic milliseconds for deadlines and lease expiry. */
int64_t steadyNowMs();

} // namespace rackmcp
