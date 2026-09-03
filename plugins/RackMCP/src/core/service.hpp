#pragma once
// The bridge server: loopback listener, per-connection sessions, handshake,
// HMAC challenge-response authentication, writer-lease handling, and command
// dispatch to a sink executed on Rack's UI thread.
//
// This file has no Rack dependencies (jansson + sockets only) so the entire
// protocol path is unit tested out of tree. Network threads never touch Rack:
// they authenticate, parse, validate, enqueue commands, and write completed
// responses (spec section 4).
#include <atomic>
#include <cstdint>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "core/lease.hpp"
#include "core/queues.hpp"
#include "core/tcp.hpp"

typedef struct json_t json_t;

namespace rackmcp {

struct BridgeCommand {
    uint64_t connectionId = 0;
    std::string requestId;
    std::string method;
    std::string operationId; // empty when not a mutating request
    json_t* payload = nullptr; // ownership passes to the sink on successful enqueue
    int64_t deadlineAtMs = 0;  // steadyNowMs() deadline
    bool mutating = false;     // the method's spec->mutating flag
    // Writer lease held by connectionId when the command was enqueued (mutating
    // methods only). The lease can lapse, be released, or move to another
    // connection before the pump drains the queue, so the executor must
    // revalidate with commandLeaseStillValid() instead of trusting the gate the
    // reader thread applied at enqueue time.
    std::string leaseId;
};

struct ServiceCallbacks {
    virtual ~ServiceCallbacks() {}
    /**
     * Called on a session thread. Must only enqueue (bounded) and return.
     * On success the sink owns cmd.payload; on failure the caller decrefs.
     */
    virtual bool enqueueCommand(BridgeCommand& cmd) = 0;
    /** Atomic snapshot for the welcome frame; must not touch Rack APIs. */
    virtual int currentPatchEpoch() = 0;
};

struct ServiceConfig {
    std::string secret; // raw 32 bytes
    std::string instanceId;
    std::string sessionId;
    std::string bridgeVersion;
    std::string rackVersion;
    std::string rackEdition = "unknown";
    size_t maxFrameBytes = 1024 * 1024;
    int maxConnections = 8;
    // Slots an unauthenticated peer may hold at once; the remainder stay
    // available to peers that completed the pairing handshake, so a local
    // process without the secret cannot lock every slot (threat model,
    // adversary 1).
    int maxUnauthConnections = 4;
    // A connection that has not authenticated within this window is dropped.
    // The first-party client's own handshake timeout is 5 s, so this never
    // fires for a healthy peer.
    int handshakeTimeoutMs = 10 * 1000;
    int64_t leaseTtlMs = 30 * 1000;
    int readPollMs = 250;
};

struct ServiceCounters {
    std::atomic<uint64_t> connectionsAccepted{0};
    std::atomic<uint64_t> connectionsRefused{0};
    std::atomic<uint64_t> authFailures{0};
    std::atomic<uint64_t> handshakeTimeouts{0};
    std::atomic<uint64_t> protocolErrors{0};
    std::atomic<uint64_t> requestsInline{0};
    std::atomic<uint64_t> requestsEnqueued{0};
    std::atomic<uint64_t> enqueueFailures{0};
    std::atomic<uint64_t> responseDrops{0};
    std::atomic<uint64_t> framesIn{0};
    std::atomic<uint64_t> framesOut{0};
};

class BridgeServer {
public:
    BridgeServer() = default;
    ~BridgeServer() { stop(); }
    BridgeServer(const BridgeServer&) = delete;
    BridgeServer& operator=(const BridgeServer&) = delete;

    bool start(const ServiceConfig& config, ServiceCallbacks* callbacks);
    /** Deterministic: closes sockets and joins every thread before returning. */
    void stop();
    bool running() const { return running_.load(); }
    uint16_t port() const { return port_; }

    /** Called from the UI thread to deliver a handler's response frame. */
    void sendFrame(uint64_t connectionId, const std::string& frameJson);
    /** Broadcast an event frame to all authenticated sessions. */
    void broadcastEvent(const std::string& frameJson);

    /** True when the connection currently holds the writer lease. */
    bool connectionIsWriter(uint64_t connectionId);

    /**
     * Re-checks a queued mutating command's writer lease at execution time.
     * Non-mutating commands always pass. The executor (the UI command pump)
     * must call this before applying a mutation: the enqueue-time gate in
     * handleRequest can no longer be trusted once the command has sat in the
     * queue (spec section 4, single-writer rule).
     */
    bool commandLeaseStillValid(const BridgeCommand& cmd);

    /** Lock-free hints for DSP-side status lights. */
    int activeSessions() const { return authedSessions_.load(); }
    bool leaseHeldHint() const { return leaseHeldHint_.load(); }

    LeaseManager& leases() { return leases_; }
    ServiceCounters& counters() { return counters_; }

private:
    struct Session {
        uint64_t id = 0;
        std::unique_ptr<TcpStream> stream;
        BoundedQueue<std::string> outbound{256};
        std::thread reader;
        std::thread writer;
        std::atomic<bool> authed{false};
        std::atomic<bool> defunct{false};
        std::atomic<bool> writerDone{false};
        std::string nonce;
        int64_t connectedAtMs = 0; // steadyNowMs() at accept; bounds the handshake
        enum class State { ExpectHello, ExpectAuth, Ready };
        State state = State::ExpectHello;
    };

    void acceptLoop();
    void readerLoop(std::shared_ptr<Session> session);
    void writerLoop(std::shared_ptr<Session> session);
    /** Returns false when the connection must be closed. */
    bool handleFrame(Session& session, const std::string& frame);
    bool handleRequest(Session& session, json_t* root);
    void handleLeaseRequest(Session& session, const std::string& id, const std::string& method,
                            json_t* payload);
    void enqueueOutbound(Session& session, const std::string& frame);
    void reapDefunct();

    ServiceConfig config_;
    ServiceCallbacks* callbacks_ = nullptr;
    TcpListener listener_;
    std::thread acceptThread_;
    std::atomic<bool> running_{false};
    std::atomic<bool> stopping_{false};
    uint16_t port_ = 0;
    std::atomic<uint64_t> nextConnectionId_{1};
    std::mutex sessionsMutex_;
    std::map<uint64_t, std::shared_ptr<Session>> sessions_;
    LeaseManager leases_;
    ServiceCounters counters_;
    std::atomic<int> authedSessions_{0};
    std::atomic<bool> leaseHeldHint_{false};
};

} // namespace rackmcp
