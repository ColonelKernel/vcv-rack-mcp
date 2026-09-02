#include "core/service.hpp"

#include <chrono>
#include <cstring>
#include <thread>
#include <jansson.h>

#include "core/canonical.hpp"
#include "core/crypto.hpp"
#include "core/framing.hpp"
#include "core/frames.hpp"
#include "gen/rackmcp_protocol_gen.hpp"

namespace rackmcp {

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

bool BridgeServer::start(const ServiceConfig& config, ServiceCallbacks* callbacks) {
    stop();
    if (config.secret.size() != 32 || !callbacks)
        return false;
    if (!socketsInit())
        return false;
    config_ = config;
    callbacks_ = callbacks;
    if (!listener_.listen(0))
        return false;
    port_ = listener_.port();
    stopping_.store(false);
    running_.store(true);
    acceptThread_ = std::thread([this] { acceptLoop(); });
    return true;
}

void BridgeServer::stop() {
    if (!running_.load() && !acceptThread_.joinable())
        return;
    stopping_.store(true);
    listener_.close();
    if (acceptThread_.joinable())
        acceptThread_.join();
    std::map<uint64_t, std::shared_ptr<Session>> sessions;
    {
        std::lock_guard<std::mutex> lock(sessionsMutex_);
        sessions.swap(sessions_);
    }
    for (auto& kv : sessions) {
        Session& s = *kv.second;
        s.stream->close();
        s.outbound.close();
        if (s.reader.joinable())
            s.reader.join();
        if (s.writer.joinable())
            s.writer.join();
    }
    running_.store(false);
}

void BridgeServer::acceptLoop() {
    while (!stopping_.load()) {
        SocketHandle client = listener_.accept(250);
        reapDefunct();
        if (client == INVALID_SOCKET_HANDLE)
            continue;
        size_t active;
        {
            std::lock_guard<std::mutex> lock(sessionsMutex_);
            active = sessions_.size();
        }
        if ((int) active >= config_.maxConnections) {
            counters_.connectionsRefused++;
            TcpStream refuse(client);
            refuse.close();
            continue;
        }
        auto session = std::make_shared<Session>();
        session->id = nextConnectionId_++;
        session->stream.reset(new TcpStream(client));
        counters_.connectionsAccepted++;
        {
            std::lock_guard<std::mutex> lock(sessionsMutex_);
            sessions_[session->id] = session;
        }
        session->reader = std::thread([this, session] { readerLoop(session); });
        session->writer = std::thread([this, session] { writerLoop(session); });
    }
}

void BridgeServer::reapDefunct() {
    std::vector<std::shared_ptr<Session>> dead;
    {
        std::lock_guard<std::mutex> lock(sessionsMutex_);
        for (auto it = sessions_.begin(); it != sessions_.end();) {
            if (it->second->defunct.load()) {
                dead.push_back(it->second);
                it = sessions_.erase(it);
            }
            else {
                ++it;
            }
        }
    }
    for (auto& s : dead) {
        if (s->reader.joinable())
            s->reader.join();
        if (s->writer.joinable())
            s->writer.join();
    }
}

void BridgeServer::readerLoop(std::shared_ptr<Session> session) {
    FrameDecoder decoder(config_.maxFrameBytes);
    uint8_t buf[16384];
    bool alive = true;
    while (alive && !stopping_.load()) {
        int n = session->stream->read(buf, sizeof(buf), config_.readPollMs);
        if (n == 0) {
            if (session->stream->timedOut())
                continue;
            break; // orderly shutdown
        }
        if (n < 0)
            break;
        if (!decoder.push(buf, (size_t) n)) {
            counters_.protocolErrors++;
            break;
        }
        std::string frame;
        while (decoder.next(frame)) {
            counters_.framesIn++;
            if (!handleFrame(*session, frame)) {
                alive = false;
                break;
            }
        }
        if (decoder.error()) {
            counters_.protocolErrors++;
            break;
        }
    }
    if (session->authed.load())
        authedSessions_.fetch_sub(1);
    leases_.onDisconnect(session->id);
    leaseHeldHint_.store(leases_.holder(steadyNowMs()).held);
    // Let the writer flush any final frames (e.g. an auth error) before the
    // socket is torn down; the writer exits once the queue is closed and empty.
    session->outbound.close();
    int64_t flushDeadline = steadyNowMs() + 1000;
    while (!session->writerDone.load() && steadyNowMs() < flushDeadline)
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
    session->stream->close();
    session->defunct.store(true);
}

void BridgeServer::writerLoop(std::shared_ptr<Session> session) {
    std::string frame;
    while (true) {
        if (!session->outbound.popWait(frame, 250)) {
            // Timeout or closed: exit only when closed AND fully drained.
            if (session->outbound.closed() && session->outbound.size() == 0)
                break;
            continue;
        }
        std::string wire;
        if (!encodeFrame(frame, config_.maxFrameBytes, wire)) {
            counters_.protocolErrors++;
            continue;
        }
        if (!session->stream->writeAll(wire.data(), wire.size()))
            break;
        counters_.framesOut++;
    }
    session->writerDone.store(true);
}

void BridgeServer::enqueueOutbound(Session& session, const std::string& frame) {
    if (!session.outbound.tryPush(frame))
        counters_.responseDrops++;
}

// ---------------------------------------------------------------------------
// Frame handling (session threads; no Rack APIs)
// ---------------------------------------------------------------------------

static bool isHex(const std::string& s, size_t len) {
    if (s.size() != len)
        return false;
    for (char c : s) {
        bool ok = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
        if (!ok)
            return false;
    }
    return true;
}

static const gen::MethodSpec* findMethod(const char* name) {
    for (size_t i = 0; i < gen::METHOD_SPEC_COUNT; i++) {
        if (std::strcmp(gen::METHOD_SPECS[i].method, name) == 0)
            return &gen::METHOD_SPECS[i];
    }
    return nullptr;
}

bool BridgeServer::handleFrame(Session& session, const std::string& frame) {
    json_error_t jerr;
    json_t* root = json_loadb(frame.data(), frame.size(), JSON_REJECT_DUPLICATES, &jerr);
    if (!root) {
        counters_.protocolErrors++;
        return false;
    }
    if (!checkJsonLimits(root, (int) gen::LIMIT_JSON_MAX_DEPTH, (long) gen::LIMIT_JSON_MAX_TOTAL_NODES,
                         (size_t) gen::LIMIT_JSON_MAX_STRING_BYTES)) {
        counters_.protocolErrors++;
        json_decref(root);
        return false;
    }
    json_t* kindJ = json_object_get(root, "kind");
    const char* kind = json_is_string(kindJ) ? json_string_value(kindJ) : "";
    bool keep = true;

    if (session.state == Session::State::ExpectHello) {
        if (std::strcmp(kind, "hello") != 0) {
            counters_.protocolErrors++;
            keep = false;
        }
        else {
            bool versionOk = false;
            json_t* versions = json_object_get(root, "versions");
            if (json_is_array(versions)) {
                size_t i;
                json_t* v;
                json_array_foreach(versions, i, v) {
                    if (json_is_integer(v) && json_integer_value(v) == gen::BRIDGE_PROTOCOL_VERSION)
                        versionOk = true;
                }
            }
            if (!versionOk) {
                enqueueOutbound(session, buildAuthResult(false, "PROTOCOL_VERSION_MISMATCH",
                                                         "no mutually supported bridge protocol version"));
                keep = false;
            }
            else {
                session.nonce = randomHex(32);
                if (session.nonce.empty()) {
                    // Fail closed: never issue a challenge without OS-grade randomness
                    // (an empty/constant nonce would make the HMAC response replayable).
                    enqueueOutbound(session, buildAuthResult(false, "INTERNAL", "secure random source unavailable"));
                    keep = false;
                }
                else {
                WelcomeInfo info;
                info.version = gen::BRIDGE_PROTOCOL_VERSION;
                info.instanceId = config_.instanceId;
                info.sessionId = config_.sessionId;
                info.bridgeVersion = config_.bridgeVersion;
                info.rackVersion = config_.rackVersion;
                info.rackEdition = config_.rackEdition;
                info.patchEpoch = callbacks_->currentPatchEpoch();
                info.nonce = session.nonce;
                enqueueOutbound(session, buildWelcome(info));
                session.state = Session::State::ExpectAuth;
                }
            }
        }
    }
    else if (session.state == Session::State::ExpectAuth) {
        if (std::strcmp(kind, "auth") != 0) {
            counters_.protocolErrors++;
            keep = false;
        }
        else {
            json_t* hmacJ = json_object_get(root, "hmac");
            std::string provided = json_is_string(hmacJ) ? json_string_value(hmacJ) : "";
            std::string expected =
                hmacSha256Hex(config_.secret,
                              authMessage(session.nonce, config_.instanceId, config_.sessionId));
            // Single-use nonce: a second auth attempt needs a new connection.
            session.nonce.clear();
            if (isHex(provided, 64) && constantTimeEqual(expected, provided)) {
                session.authed.store(true);
                authedSessions_.fetch_add(1);
                session.state = Session::State::Ready;
                enqueueOutbound(session, buildAuthResult(true, nullptr, nullptr));
            }
            else {
                counters_.authFailures++;
                enqueueOutbound(session, buildAuthResult(false, "AUTHENTICATION_FAILED",
                                                         "pairing secret mismatch"));
                keep = false;
            }
        }
    }
    else {
        // Ready state.
        if (std::strcmp(kind, "ping") == 0) {
            json_t* idJ = json_object_get(root, "id");
            if (json_is_string(idJ))
                enqueueOutbound(session, buildPong(json_string_value(idJ)));
        }
        else if (std::strcmp(kind, "req") == 0) {
            keep = handleRequest(session, root);
        }
        else {
            counters_.protocolErrors++;
            keep = false;
        }
    }
    json_decref(root);
    return keep;
}

bool BridgeServer::handleRequest(Session& session, json_t* root) {
    json_t* idJ = json_object_get(root, "id");
    json_t* methodJ = json_object_get(root, "method");
    json_t* deadlineJ = json_object_get(root, "deadlineMs");
    json_t* opIdJ = json_object_get(root, "operationId");
    json_t* payload = json_object_get(root, "payload");

    std::string id = json_is_string(idJ) ? json_string_value(idJ) : "";
    if (!isHex(id, 16)) {
        counters_.protocolErrors++;
        return false;
    }
    const char* method = json_is_string(methodJ) ? json_string_value(methodJ) : "";
    const gen::MethodSpec* spec = findMethod(method);
    if (!spec) {
        enqueueOutbound(session, buildResError(id, "UNSUPPORTED_OPERATION",
                                               std::string("unknown method: ") + method, false, false));
        return true;
    }
    if (!json_is_integer(deadlineJ) || json_integer_value(deadlineJ) < 1 ||
        json_integer_value(deadlineJ) > 600000) {
        enqueueOutbound(session, buildResError(id, "BAD_REQUEST", "invalid deadlineMs", false, false));
        return true;
    }
    int64_t deadlineAtMs = steadyNowMs() + json_integer_value(deadlineJ);

    std::string operationId;
    if (json_is_string(opIdJ))
        operationId = json_string_value(opIdJ);

    // Inline service-state methods (no Rack APIs involved).
    if (std::strncmp(method, "lease.", 6) == 0) {
        counters_.requestsInline++;
        handleLeaseRequest(session, id, method, payload);
        return true;
    }

    if (spec->mutating) {
        if (operationId.size() != 36) {
            enqueueOutbound(session,
                            buildResError(id, "BAD_REQUEST",
                                          "mutating requests require a UUID operationId", false, false));
            return true;
        }
        if (!leases_.isWriter(session.id, steadyNowMs())) {
            enqueueOutbound(session, buildResError(id, "WRITER_LEASE_REQUIRED",
                                                   "acquire the writer lease before mutating", true,
                                                   false));
            return true;
        }
    }

    BridgeCommand cmd;
    cmd.connectionId = session.id;
    cmd.requestId = id;
    cmd.method = method;
    cmd.operationId = operationId;
    cmd.deadlineAtMs = deadlineAtMs;
    cmd.payload = payload ? json_incref(payload) : json_object();
    if (!callbacks_->enqueueCommand(cmd)) {
        json_decref(cmd.payload);
        counters_.enqueueFailures++;
        enqueueOutbound(session, buildResError(id, "BRIDGE_NOT_READY",
                                               "command queue unavailable or full", true, false));
        return true;
    }
    counters_.requestsEnqueued++;
    return true;
}

void BridgeServer::handleLeaseRequest(Session& session, const std::string& id,
                                      const std::string& method, json_t* payload) {
    int64_t now = steadyNowMs();
    if (method == "lease.acquire") {
        json_t* nameJ = payload ? json_object_get(payload, "clientName") : nullptr;
        std::string name = json_is_string(nameJ) ? json_string_value(nameJ) : "unknown";
        if (name.size() > 128)
            name.resize(128);
        std::string leaseId;
        LeaseManager::AcquireResult r =
            leases_.acquire(session.id, name, now, config_.leaseTtlMs, leaseId);
        if (r == LeaseManager::AcquireResult::Ok) {
            json_t* p = json_pack("{s:s, s:I}", "leaseId", leaseId.c_str(), "expiresInMs",
                                  (json_int_t) config_.leaseTtlMs);
            enqueueOutbound(session, buildResOk(id, p));
        }
        else {
            LeaseHolder h = leases_.holder(now);
            enqueueOutbound(session, buildResError(id, "LEASE_HELD",
                                                   "writer lease held by " + h.clientName, true, false));
        }
    }
    else if (method == "lease.renew") {
        json_t* leaseJ = payload ? json_object_get(payload, "leaseId") : nullptr;
        std::string leaseId = json_is_string(leaseJ) ? json_string_value(leaseJ) : "";
        if (leases_.renew(session.id, leaseId, now, config_.leaseTtlMs)) {
            json_t* p = json_pack("{s:I}", "expiresInMs", (json_int_t) config_.leaseTtlMs);
            enqueueOutbound(session, buildResOk(id, p));
        }
        else {
            enqueueOutbound(session, buildResError(id, "WRITER_LEASE_REQUIRED",
                                                   "lease invalid or expired", true, false));
        }
    }
    else if (method == "lease.release") {
        json_t* leaseJ = payload ? json_object_get(payload, "leaseId") : nullptr;
        std::string leaseId = json_is_string(leaseJ) ? json_string_value(leaseJ) : "";
        leases_.release(session.id, leaseId);
        enqueueOutbound(session, buildResOk(id, nullptr));
    }
    else {
        enqueueOutbound(session, buildResError(id, "UNSUPPORTED_OPERATION", "unknown lease method",
                                               false, false));
    }
    leaseHeldHint_.store(leases_.holder(steadyNowMs()).held);
}

// ---------------------------------------------------------------------------
// UI-thread entry points
// ---------------------------------------------------------------------------

void BridgeServer::sendFrame(uint64_t connectionId, const std::string& frameJson) {
    std::shared_ptr<Session> session;
    {
        std::lock_guard<std::mutex> lock(sessionsMutex_);
        auto it = sessions_.find(connectionId);
        if (it != sessions_.end())
            session = it->second;
    }
    if (session)
        enqueueOutbound(*session, frameJson);
}

void BridgeServer::broadcastEvent(const std::string& frameJson) {
    std::vector<std::shared_ptr<Session>> targets;
    {
        std::lock_guard<std::mutex> lock(sessionsMutex_);
        for (auto& kv : sessions_)
            if (kv.second->authed.load())
                targets.push_back(kv.second);
    }
    for (auto& s : targets)
        enqueueOutbound(*s, frameJson);
}

bool BridgeServer::connectionIsWriter(uint64_t connectionId) {
    return leases_.isWriter(connectionId, steadyNowMs());
}

} // namespace rackmcp
