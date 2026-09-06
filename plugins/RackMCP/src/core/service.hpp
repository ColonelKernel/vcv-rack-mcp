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

#include "core/frames.hpp"
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
    int64_t enqueuedAtUs = 0;  // steadyNowUs() at enqueue, for latency sampling
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
    /** Commands whose deadline expired while queued for the UI thread. */
    std::atomic<uint64_t> requestTimeouts{0};
    /** Results too large for one frame, answered with RESULT_TOO_LARGE. */
    std::atomic<uint64_t> oversizedResults{0};
    /** Transactions whose apply failed and whose inverses were run. */
    std::atomic<uint64_t> rollbacks{0};
    /**
     * Smoothed queue-wait-plus-execution time, in microseconds.
     *
     * Covers commands drained by the UI pump, which is where time is actually
     * spent; requests answered inline on the reader thread (leases, ping) never
     * queue and are not sampled. Written only by the pump, so a plain relaxed
     * load/store pair is enough -- there is exactly one writer.
     */
    std::atomic<uint64_t> requestLatencyEwmaUs{0};
};

/**
 * One EWMA step, alpha = 1/8, in fixed-point microseconds.
 *
 * `prevUs == 0` means nothing has been sampled yet, so the first sample seeds
 * the average outright rather than being dragged down from zero -- otherwise
 * the reported latency would take a dozen requests to become meaningful and
 * would understate the whole time it was climbing. Integer arithmetic keeps
 * this usable from the audio-adjacent UI thread with no floating point.
 */
inline uint64_t ewmaStepUs(uint64_t prevUs, uint64_t sampleUs) {
    if (prevUs == 0)
        return sampleUs;
    // prev + (sample - prev) / 8, without unsigned underflow when sample < prev.
    if (sampleUs >= prevUs)
        return prevUs + (sampleUs - prevUs) / 8;
    return prevUs - (prevUs - sampleUs) / 8;
}

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

    /**
     * Recomputes the lease hint. Must be called periodically from the UI
     * thread, not only on lease traffic.
     *
     * A lease also ends by simply timing out, and nothing sends a message when
     * that happens: a client that acquires the lease and then goes idle without
     * releasing it leaves the hint stuck true until its next lease request or
     * its disconnect. The Bridge panel's LEASE light would then claim a writer
     * holds the lease for as long as that client stayed connected -- while the
     * panel's own text, which reads leases().holder() live, said otherwise.
     *
     * It cannot be computed on demand where it is read: leaseHeldHint() is
     * called from Module::process(), and holder() takes a mutex.
     */
    void refreshLeaseHint() { leaseHeldHint_.store(leases_.holder(steadyNowMs()).held); }

    LeaseManager& leases() { return leases_; }
    ServiceCounters& counters() { return counters_; }
    /** Frame cap this server was configured with; the executor needs it to
     *  substitute RESULT_TOO_LARGE while the request id is still in hand. */
    size_t maxFrameBytes() const { return config_.maxFrameBytes; }

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
