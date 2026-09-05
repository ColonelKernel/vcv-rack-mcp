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

/**
 * Returns `frame` when it fits the bridge frame cap, and a RESULT_TOO_LARGE
 * response otherwise.
 *
 * An oversized response cannot go on the wire: encodeFrame refuses it and the
 * writer loop, which holds only the encoded string, has no request id left to
 * answer with -- so the reply is dropped and the caller learns nothing until
 * its own deadline expires and reports a timeout. A timeout is the wrong
 * diagnosis: retrying reproduces it forever, because the result is too big
 * rather than late. Substituting the error here, where the request id and the
 * method are still in hand, turns that into an answer naming the real cause.
 *
 * `mutating` is passed through as mutationMayHaveOccurred: a mutating command
 * has already run by the time its reply is built, so the caller must not read
 * this error as "nothing happened".
 */
std::string capResponseFrame(const std::string& frame, const std::string& id,
                             const std::string& method, size_t maxFrameBytes, bool mutating);

/** The exact message an authenticating client must HMAC. */
std::string authMessage(const std::string& nonce, const std::string& instanceId,
                        const std::string& sessionId);

/** Monotonic milliseconds for deadlines and lease expiry. */
int64_t steadyNowMs();

} // namespace rackmcp
