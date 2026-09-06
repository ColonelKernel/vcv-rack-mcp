#include <doctest.h>
#include <jansson.h>
#include <chrono>
#include <cstdint>
#include <mutex>
#include <string>
#include <thread>
#include <vector>
#include "core/crypto.hpp"
#include "core/framing.hpp"
#include "core/frames.hpp"
#include "core/service.hpp"
#include "core/uuid.hpp"

using namespace rackmcp;

namespace {

struct TestSink : ServiceCallbacks {
    std::mutex mutex;
    std::vector<BridgeCommand> commands;
    bool acceptCommands = true;

    bool enqueueCommand(BridgeCommand& cmd) override {
        std::lock_guard<std::mutex> lock(mutex);
        if (!acceptCommands)
            return false;
        commands.push_back(cmd);
        return true;
    }
    int currentPatchEpoch() override { return 1; }

    ~TestSink() override {
        for (auto& c : commands)
            if (c.payload)
                json_decref(c.payload);
    }
};

struct TestClient {
    SocketHandle fd = INVALID_SOCKET_HANDLE;
    TcpStream* stream = nullptr;
    FrameDecoder decoder{1024 * 1024};

    bool connect(uint16_t port) {
        fd = tcpConnectLoopback(port, 1000);
        if (fd == INVALID_SOCKET_HANDLE)
            return false;
        stream = new TcpStream(fd);
        return true;
    }
    ~TestClient() { delete stream; }

    bool send(const std::string& payload) {
        std::string wire;
        if (!encodeFrame(payload, 1024 * 1024, wire))
            return false;
        return stream->writeAll(wire.data(), wire.size());
    }

    /** Reads until one frame is available or timeout. Empty string = none. */
    std::string readFrame(int timeoutMs = 2000) {
        std::string frame;
        if (decoder.next(frame))
            return frame;
        int64_t deadline = steadyNowMs() + timeoutMs;
        uint8_t buf[8192];
        while (steadyNowMs() < deadline) {
            int n = stream->read(buf, sizeof(buf), 100);
            if (n < 0)
                return "";
            if (n == 0) {
                if (stream->timedOut())
                    continue;
                return "";
            }
            if (!decoder.push(buf, (size_t) n))
                return "";
            if (decoder.next(frame))
                return frame;
        }
        return "";
    }

    json_t* readJson(int timeoutMs = 2000) {
        std::string f = readFrame(timeoutMs);
        if (f.empty())
            return nullptr;
        json_error_t err;
        return json_loads(f.c_str(), 0, &err);
    }
};

struct Harness {
    std::string secret;
    ServiceConfig config;
    TestSink sink;
    BridgeServer server;

    /** 0 keeps the shipped default for that knob. */
    explicit Harness(int handshakeTimeoutMs = 0, int maxUnauthConnections = 0) {
        uint8_t raw[32];
        REQUIRE(randomBytes(raw, 32));
        secret.assign((const char*) raw, 32);
        config.secret = secret;
        config.instanceId = uuid4();
        config.sessionId = uuid4();
        config.bridgeVersion = "0.1.0-test";
        config.rackVersion = "2.6.6";
        config.rackEdition = "Pro";
        if (handshakeTimeoutMs > 0)
            config.handshakeTimeoutMs = handshakeTimeoutMs;
        if (maxUnauthConnections > 0)
            config.maxUnauthConnections = maxUnauthConnections;
        REQUIRE(server.start(config, &sink));
    }
    ~Harness() { server.stop(); }

    /** Performs hello+auth; returns the authed client. */
    void handshake(TestClient& c, bool wrongSecret = false) {
        REQUIRE(c.connect(server.port()));
        REQUIRE(c.send("{\"kind\":\"hello\",\"versions\":[1],\"client\":{\"name\":\"t\",\"version\":\"0\"}}"));
        json_t* welcome = c.readJson();
        REQUIRE(welcome);
        CHECK(std::string(json_string_value(json_object_get(welcome, "kind"))) == "welcome");
        std::string nonce = json_string_value(json_object_get(welcome, "nonce"));
        json_decref(welcome);
        std::string key = wrongSecret ? std::string(32, 'x') : secret;
        std::string hmac = hmacSha256Hex(key, authMessage(nonce, config.instanceId, config.sessionId));
        REQUIRE(c.send("{\"kind\":\"auth\",\"hmac\":\"" + hmac + "\"}"));
    }
};

std::string reqFrame(const std::string& id, const std::string& method, const std::string& payload,
                     const std::string& operationId = "") {
    std::string opPart =
        operationId.empty() ? "" : "\"operationId\":\"" + operationId + "\",";
    return "{\"kind\":\"req\",\"id\":\"" + id + "\",\"method\":\"" + method +
           "\",\"deadlineMs\":5000," + opPart + "\"payload\":" + payload + "}";
}

} // namespace

TEST_CASE("handshake and authentication succeed with the right secret") {
    Harness h;
    TestClient c;
    h.handshake(c);
    json_t* res = c.readJson();
    REQUIRE(res);
    CHECK(std::string(json_string_value(json_object_get(res, "kind"))) == "authResult");
    CHECK(json_is_true(json_object_get(res, "ok")));
    json_decref(res);
}

TEST_CASE("wrong secret is rejected in constant time and counted") {
    Harness h;
    TestClient c;
    h.handshake(c, /*wrongSecret=*/true);
    json_t* res = c.readJson();
    REQUIRE(res);
    CHECK_FALSE(json_is_true(json_object_get(res, "ok")));
    json_t* err = json_object_get(res, "error");
    CHECK(std::string(json_string_value(json_object_get(err, "code"))) == "AUTHENTICATION_FAILED");
    json_decref(res);
    // Connection must be closed: next read returns nothing.
    CHECK(c.readFrame(500).empty());
    CHECK(h.server.counters().authFailures.load() == 1);
}

TEST_CASE("unsupported protocol version is refused") {
    Harness h;
    TestClient c;
    REQUIRE(c.connect(h.server.port()));
    REQUIRE(c.send("{\"kind\":\"hello\",\"versions\":[999],\"client\":{\"name\":\"t\",\"version\":\"0\"}}"));
    json_t* res = c.readJson();
    REQUIRE(res);
    json_t* err = json_object_get(res, "error");
    CHECK(std::string(json_string_value(json_object_get(err, "code"))) ==
          "PROTOCOL_VERSION_MISMATCH");
    json_decref(res);
}

TEST_CASE("requests before authentication close the connection") {
    Harness h;
    TestClient c;
    REQUIRE(c.connect(h.server.port()));
    REQUIRE(c.send(reqFrame("0123456789abcdef", "status.get", "{}")));
    CHECK(c.readFrame(500).empty());
    {
        std::lock_guard<std::mutex> lock(h.sink.mutex);
        CHECK(h.sink.commands.empty());
    }
}

TEST_CASE("ping/pong after auth") {
    Harness h;
    TestClient c;
    h.handshake(c);
    json_decref(c.readJson()); // authResult
    REQUIRE(c.send("{\"kind\":\"ping\",\"id\":\"00000000000000aa\"}"));
    json_t* pong = c.readJson();
    REQUIRE(pong);
    CHECK(std::string(json_string_value(json_object_get(pong, "kind"))) == "pong");
    CHECK(std::string(json_string_value(json_object_get(pong, "id"))) == "00000000000000aa");
    json_decref(pong);
}

TEST_CASE("read-only request is enqueued and response frames flow back") {
    Harness h;
    TestClient c;
    h.handshake(c);
    json_decref(c.readJson());
    REQUIRE(c.send(reqFrame("00000000000000ab", "status.get", "{}")));
    // Wait for the sink to receive it.
    uint64_t connId = 0;
    for (int i = 0; i < 100; i++) {
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
        std::lock_guard<std::mutex> lock(h.sink.mutex);
        if (!h.sink.commands.empty()) {
            connId = h.sink.commands[0].connectionId;
            CHECK(h.sink.commands[0].method == "status.get");
            CHECK(h.sink.commands[0].requestId == "00000000000000ab");
            break;
        }
    }
    REQUIRE(connId != 0);
    // Simulate the UI pump responding.
    h.server.sendFrame(connId, buildResOk("00000000000000ab", json_pack("{s:s}", "hello", "world")));
    json_t* res = c.readJson();
    REQUIRE(res);
    CHECK(json_is_true(json_object_get(res, "ok")));
    json_decref(res);
}

TEST_CASE("writer lease lifecycle across two connections") {
    Harness h;
    TestClient a, b;
    h.handshake(a);
    json_decref(a.readJson());
    h.handshake(b);
    json_decref(b.readJson());

    // a acquires.
    REQUIRE(a.send(reqFrame("00000000000000a1", "lease.acquire", "{\"clientName\":\"alpha\"}")));
    json_t* res = a.readJson();
    REQUIRE(res);
    REQUIRE(json_is_true(json_object_get(res, "ok")));
    std::string leaseId =
        json_string_value(json_object_get(json_object_get(res, "payload"), "leaseId"));
    json_decref(res);

    // b is refused.
    REQUIRE(b.send(reqFrame("00000000000000b1", "lease.acquire", "{\"clientName\":\"beta\"}")));
    res = b.readJson();
    REQUIRE(res);
    CHECK_FALSE(json_is_true(json_object_get(res, "ok")));
    CHECK(std::string(json_string_value(
              json_object_get(json_object_get(res, "error"), "code"))) == "LEASE_HELD");
    json_decref(res);

    // a renews, then releases; b can now acquire.
    REQUIRE(a.send(reqFrame("00000000000000a2", "lease.renew", "{\"leaseId\":\"" + leaseId + "\"}")));
    res = a.readJson();
    REQUIRE(json_is_true(json_object_get(res, "ok")));
    json_decref(res);
    REQUIRE(a.send(reqFrame("00000000000000a3", "lease.release", "{\"leaseId\":\"" + leaseId + "\"}")));
    res = a.readJson();
    REQUIRE(json_is_true(json_object_get(res, "ok")));
    json_decref(res);
    REQUIRE(b.send(reqFrame("00000000000000b2", "lease.acquire", "{\"clientName\":\"beta\"}")));
    res = b.readJson();
    REQUIRE(json_is_true(json_object_get(res, "ok")));
    json_decref(res);
}

TEST_CASE("mutating request without lease or operationId is refused") {
    Harness h;
    TestClient c;
    h.handshake(c);
    json_decref(c.readJson());
    // No operationId.
    REQUIRE(c.send(reqFrame("00000000000000c1", "txn.commit", "{}")));
    json_t* res = c.readJson();
    REQUIRE(res);
    CHECK(std::string(json_string_value(
              json_object_get(json_object_get(res, "error"), "code"))) == "BAD_REQUEST");
    json_decref(res);
    // operationId but no lease.
    REQUIRE(c.send(reqFrame("00000000000000c2", "txn.commit", "{}", uuid4())));
    res = c.readJson();
    REQUIRE(res);
    CHECK(std::string(json_string_value(
              json_object_get(json_object_get(res, "error"), "code"))) == "WRITER_LEASE_REQUIRED");
    json_decref(res);
    {
        std::lock_guard<std::mutex> lock(h.sink.mutex);
        CHECK(h.sink.commands.empty());
    }
}

TEST_CASE("lease is released when the holding connection drops") {
    Harness h;
    {
        TestClient a;
        h.handshake(a);
        json_decref(a.readJson());
        REQUIRE(a.send(reqFrame("00000000000000a1", "lease.acquire", "{\"clientName\":\"alpha\"}")));
        json_t* res = a.readJson();
        REQUIRE(json_is_true(json_object_get(res, "ok")));
        json_decref(res);
    } // a's socket closes here
    TestClient b;
    h.handshake(b);
    json_decref(b.readJson());
    // Poll until the server notices the disconnect.
    bool acquired = false;
    for (int attempt = 0; attempt < 50 && !acquired; attempt++) {
        REQUIRE(b.send(reqFrame("00000000000000b9", "lease.acquire", "{\"clientName\":\"beta\"}")));
        json_t* res = b.readJson();
        REQUIRE(res);
        acquired = json_is_true(json_object_get(res, "ok"));
        json_decref(res);
        if (!acquired)
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
    CHECK(acquired);
}

TEST_CASE("unknown method yields UNSUPPORTED_OPERATION") {
    Harness h;
    TestClient c;
    h.handshake(c);
    json_decref(c.readJson());
    REQUIRE(c.send(reqFrame("00000000000000d1", "status.get", "{}")));
    // valid method goes to the queue; now an invalid one:
    REQUIRE(c.send("{\"kind\":\"req\",\"id\":\"00000000000000d2\",\"method\":\"evil.method\",\"deadlineMs\":5000,\"payload\":{}}"));
    json_t* res = c.readJson();
    REQUIRE(res);
    CHECK(std::string(json_string_value(
              json_object_get(json_object_get(res, "error"), "code"))) == "UNSUPPORTED_OPERATION");
    json_decref(res);
}

TEST_CASE("queue-full yields BRIDGE_NOT_READY and payload is not leaked") {
    Harness h;
    {
        std::lock_guard<std::mutex> lock(h.sink.mutex);
        h.sink.acceptCommands = false;
    }
    TestClient c;
    h.handshake(c);
    json_decref(c.readJson());
    REQUIRE(c.send(reqFrame("00000000000000e1", "status.get", "{}")));
    json_t* res = c.readJson();
    REQUIRE(res);
    CHECK(std::string(json_string_value(
              json_object_get(json_object_get(res, "error"), "code"))) == "BRIDGE_NOT_READY");
    json_t* err = json_object_get(res, "error");
    CHECK(json_is_true(json_object_get(err, "retrySafe")));
    CHECK_FALSE(json_is_true(json_object_get(err, "mutationMayHaveOccurred")));
    json_decref(res);
}

TEST_CASE("stop() is deterministic with live authenticated connections") {
    auto* h = new Harness();
    std::vector<TestClient*> clients;
    for (int i = 0; i < 4; i++) {
        auto* c = new TestClient();
        h->handshake(*c);
        json_decref(c->readJson());
        c->send(reqFrame("00000000000000f" + std::to_string(i), "status.get", "{}"));
        clients.push_back(c);
    }
    auto start = std::chrono::steady_clock::now();
    h->server.stop();
    auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                  std::chrono::steady_clock::now() - start)
                  .count();
    CHECK(ms < 3000);
    delete h;
    for (auto* c : clients)
        delete c;
}

TEST_CASE("oversize frame from client kills only that connection") {
    Harness h;
    TestClient bad;
    h.handshake(bad);
    json_decref(bad.readJson());
    // Declare a 2 MiB frame.
    uint8_t hdr[4] = {0x00, 0x20, 0x00, 0x00};
    REQUIRE(bad.stream->writeAll(hdr, 4));
    std::string junk(1024, 'j');
    bad.stream->writeAll(junk.data(), junk.size());
    CHECK(bad.readFrame(1000).empty());

    TestClient good;
    h.handshake(good);
    json_t* res = good.readJson();
    REQUIRE(res);
    CHECK(json_is_true(json_object_get(res, "ok")));
    json_decref(res);
}

TEST_CASE("writer survives long idle periods (regression: timeout must not kill it)") {
    Harness h;
    TestClient c;
    h.handshake(c);
    json_decref(c.readJson());
    REQUIRE(c.send(reqFrame("00000000000000aa", "status.get", "{}")));
    uint64_t connId = 0;
    for (int i = 0; i < 100 && connId == 0; i++) {
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
        std::lock_guard<std::mutex> lock(h.sink.mutex);
        if (!h.sink.commands.empty())
            connId = h.sink.commands[0].connectionId;
    }
    REQUIRE(connId != 0);
    // Idle well past the writer's poll interval before responding.
    std::this_thread::sleep_for(std::chrono::milliseconds(800));
    h.server.sendFrame(connId, buildResOk("00000000000000aa", nullptr));
    json_t* res = c.readJson(3000);
    REQUIRE(res);
    CHECK(json_is_true(json_object_get(res, "ok")));
    json_decref(res);
    CHECK(h.server.counters().responseDrops.load() == 0);
}

// ---------------------------------------------------------------------------
// Unauthenticated connections must not live (or hold a slot) forever.
// ---------------------------------------------------------------------------

TEST_CASE("a connection that never authenticates is dropped at the handshake deadline") {
    Harness h(/*handshakeTimeoutMs=*/300);
    TestClient c;
    REQUIRE(c.connect(h.server.port()));
    // Sends nothing at all: the server must close it instead of holding the slot.
    CHECK(c.readFrame(3000).empty());
    bool timedOut = false;
    for (int i = 0; i < 200 && !timedOut; i++) {
        if (h.server.counters().handshakeTimeouts.load() >= 1)
            timedOut = true;
        else
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    CHECK(timedOut);
}

TEST_CASE("an authenticated session outlives the handshake deadline") {
    Harness h(/*handshakeTimeoutMs=*/300);
    TestClient c;
    h.handshake(c);
    json_decref(c.readJson()); // authResult
    std::this_thread::sleep_for(std::chrono::milliseconds(700));
    REQUIRE(c.send("{\"kind\":\"ping\",\"id\":\"00000000000000ab\"}"));
    json_t* pong = c.readJson();
    REQUIRE(pong);
    CHECK(std::string(json_string_value(json_object_get(pong, "kind"))) == "pong");
    json_decref(pong);
    CHECK(h.server.counters().handshakeTimeouts.load() == 0);
}

TEST_CASE("unauthenticated peers cannot occupy every connection slot") {
    Harness h(/*handshakeTimeoutMs=*/60000, /*maxUnauthConnections=*/2);
    {
        TestClient a, b;
        REQUIRE(a.connect(h.server.port()));
        REQUIRE(b.connect(h.server.port()));
        for (int i = 0; i < 200 && h.server.counters().connectionsAccepted.load() < 2; i++)
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        REQUIRE(h.server.counters().connectionsAccepted.load() == 2);
        TestClient squatter;
        REQUIRE(squatter.connect(h.server.port()));
        bool refused = false;
        for (int i = 0; i < 200 && !refused; i++) {
            if (h.server.counters().connectionsRefused.load() >= 1)
                refused = true;
            else
                std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }
        CHECK(refused);
        CHECK(h.server.counters().connectionsAccepted.load() == 2);
    } // the squatters disconnect here
    // The slots come back, so a real client can still pair.
    bool welcomed = false;
    for (int attempt = 0; attempt < 60 && !welcomed; attempt++) {
        TestClient good;
        if (good.connect(h.server.port()) &&
            good.send("{\"kind\":\"hello\",\"versions\":[1],\"client\":{\"name\":\"t\",\"version\":\"0\"}}")) {
            json_t* w = good.readJson(300);
            if (w) {
                json_t* kind = json_object_get(w, "kind");
                welcomed = json_is_string(kind) && std::string(json_string_value(kind)) == "welcome";
                json_decref(w);
            }
        }
        if (!welcomed)
            std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
    CHECK(welcomed);
}

// ---------------------------------------------------------------------------
// The writer lease must survive the trip through the command queue.
// ---------------------------------------------------------------------------

TEST_CASE("a queued mutating command carries its lease and stops validating when it moves") {
    Harness h;
    TestClient a, b;
    h.handshake(a);
    json_decref(a.readJson());
    h.handshake(b);
    json_decref(b.readJson());

    REQUIRE(a.send(reqFrame("00000000000000a1", "lease.acquire", "{\"clientName\":\"alpha\"}")));
    json_t* res = a.readJson();
    REQUIRE(res);
    REQUIRE(json_is_true(json_object_get(res, "ok")));
    std::string leaseId =
        json_string_value(json_object_get(json_object_get(res, "payload"), "leaseId"));
    json_decref(res);

    REQUIRE(a.send(reqFrame("00000000000000a2", "txn.commit", "{}", uuid4())));
    BridgeCommand queued;
    for (int i = 0; i < 200 && queued.requestId.empty(); i++) {
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
        std::lock_guard<std::mutex> lock(h.sink.mutex);
        if (!h.sink.commands.empty()) {
            // Copy the identity fields only; the sink keeps ownership of payload.
            queued.connectionId = h.sink.commands[0].connectionId;
            queued.requestId = h.sink.commands[0].requestId;
            queued.method = h.sink.commands[0].method;
            queued.mutating = h.sink.commands[0].mutating;
            queued.leaseId = h.sink.commands[0].leaseId;
        }
    }
    REQUIRE(queued.requestId == "00000000000000a2");
    CHECK(queued.mutating);
    CHECK(queued.leaseId == leaseId);
    CHECK(h.server.commandLeaseStillValid(queued));

    // a releases; the command that is still queued must no longer be executable.
    REQUIRE(a.send(reqFrame("00000000000000a3", "lease.release",
                            "{\"leaseId\":\"" + leaseId + "\"}")));
    res = a.readJson();
    REQUIRE(res);
    REQUIRE(json_is_true(json_object_get(res, "ok")));
    json_decref(res);
    CHECK_FALSE(h.server.commandLeaseStillValid(queued));

    // Nor after the lease moves to another connection.
    REQUIRE(b.send(reqFrame("00000000000000b1", "lease.acquire", "{\"clientName\":\"beta\"}")));
    res = b.readJson();
    REQUIRE(res);
    REQUIRE(json_is_true(json_object_get(res, "ok")));
    json_decref(res);
    CHECK_FALSE(h.server.commandLeaseStillValid(queued));
}

TEST_CASE("read-only commands never need a lease at execution time") {
    Harness h;
    BridgeCommand readOnly;
    readOnly.connectionId = 12345;
    readOnly.method = "status.get";
    CHECK(h.server.commandLeaseStillValid(readOnly));
}

// ---------------------------------------------------------------------------
// Frame building must fail safe: an empty frame kills the client's session.
// ---------------------------------------------------------------------------

TEST_CASE("a frame that cannot be packed falls back to a valid error frame") {
    // A message that is not valid UTF-8 makes json_pack fail.
    std::string message = "writer lease held by ";
    message += (char) 0xE2;
    message += (char) 0x82; // truncated 3-byte sequence
    std::string frame = buildResError("00000000000000c1", "LEASE_HELD", message, true, false);
    REQUIRE_FALSE(frame.empty());
    json_error_t err;
    json_t* o = json_loads(frame.c_str(), 0, &err);
    REQUIRE(o);
    CHECK(std::string(json_string_value(json_object_get(o, "kind"))) == "res");
    CHECK(std::string(json_string_value(json_object_get(o, "id"))) == "00000000000000c1");
    CHECK_FALSE(json_is_true(json_object_get(o, "ok")));
    CHECK(std::string(json_string_value(
              json_object_get(json_object_get(o, "error"), "code"))) == "INTERNAL");
    json_decref(o);

    // The successful-response builder is fail-safe too.
    std::string authFrame = buildAuthResult(false, "AUTHENTICATION_FAILED", message.c_str());
    REQUIRE_FALSE(authFrame.empty());
    o = json_loads(authFrame.c_str(), 0, &err);
    REQUIRE(o);
    CHECK(std::string(json_string_value(json_object_get(o, "kind"))) == "authResult");
    CHECK_FALSE(json_is_true(json_object_get(o, "ok")));
    json_decref(o);
}

TEST_CASE("an empty frame is dropped instead of tearing the session down") {
    Harness h;
    TestClient c;
    h.handshake(c);
    json_decref(c.readJson());
    REQUIRE(c.send(reqFrame("00000000000000d1", "status.get", "{}")));
    uint64_t connId = 0;
    for (int i = 0; i < 200 && connId == 0; i++) {
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
        std::lock_guard<std::mutex> lock(h.sink.mutex);
        if (!h.sink.commands.empty())
            connId = h.sink.commands[0].connectionId;
    }
    REQUIRE(connId != 0);
    h.server.sendFrame(connId, std::string()); // what a failed builder returns
    CHECK(h.server.counters().responseDrops.load() == 1);
    // The session is still usable: a 0-length frame never reached the client.
    REQUIRE(c.send("{\"kind\":\"ping\",\"id\":\"00000000000000d2\"}"));
    json_t* pong = c.readJson();
    REQUIRE(pong);
    CHECK(std::string(json_string_value(json_object_get(pong, "kind"))) == "pong");
    json_decref(pong);
}

TEST_CASE("a clientName cut mid-UTF-8 does not poison later frames") {
    Harness h;
    TestClient a, b;
    h.handshake(a);
    json_decref(a.readJson());
    h.handshake(b);
    json_decref(b.readJson());
    // 126 ASCII bytes plus a 3-byte character occupying bytes 127-129, so a
    // byte-boundary truncation at 128 would leave an invalid fragment.
    std::string name(126, 'n');
    name += "\xE2\x82\xAC"; // U+20AC EURO SIGN
    REQUIRE(a.send(reqFrame("00000000000000e1", "lease.acquire",
                            "{\"clientName\":\"" + name + "\"}")));
    json_t* res = a.readJson();
    REQUIRE(res);
    REQUIRE(json_is_true(json_object_get(res, "ok")));
    json_decref(res);

    // b's refusal quotes the stored name; it must still be a well-formed frame.
    REQUIRE(b.send(reqFrame("00000000000000e2", "lease.acquire", "{\"clientName\":\"beta\"}")));
    res = b.readJson();
    REQUIRE(res);
    CHECK_FALSE(json_is_true(json_object_get(res, "ok")));
    CHECK(std::string(json_string_value(
              json_object_get(json_object_get(res, "error"), "code"))) == "LEASE_HELD");
    json_decref(res);
}

// ---------------------------------------------------------------------------
// Shutdown flushes what is already queued, without hanging.
// ---------------------------------------------------------------------------

TEST_CASE("stop() flushes queued frames before closing the socket") {
    auto* h = new Harness();
    TestClient c;
    h->handshake(c);
    json_decref(c.readJson()); // authResult
    // Exactly what RackBridge::stop() does immediately before stopping.
    h->server.broadcastEvent(buildEvent("shutting_down"));
    auto start = std::chrono::steady_clock::now();
    h->server.stop();
    auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                  std::chrono::steady_clock::now() - start)
                  .count();
    CHECK(ms < 3000);
    json_t* evt = c.readJson(1000);
    REQUIRE(evt);
    CHECK(std::string(json_string_value(json_object_get(evt, "kind"))) == "evt");
    CHECK(std::string(json_string_value(json_object_get(evt, "event"))) == "shutting_down");
    json_decref(evt);
    delete h;
}

/**
 * A writer lease also ends by timing out, and nothing sends a message when it
 * does. The DSP-side hint behind the Bridge panel's LEASE light was only
 * recomputed on lease traffic and on disconnect, so a client that acquired the
 * lease and then sat idle left the light asserting a writer held the lease for
 * as long as it stayed connected -- contradicting the panel's own text, which
 * reads holder() live on the UI thread.
 */
TEST_CASE("lease hint stops claiming a holder once the lease has timed out") {
    BridgeServer server;
    int64_t now = steadyNowMs();
    std::string leaseId;
    REQUIRE(server.leases().acquire(1, "test-client", now, 50, leaseId) ==
            LeaseManager::AcquireResult::Ok);

    server.refreshLeaseHint();
    CHECK(server.leaseHeldHint() == true);
    CHECK(server.leases().holder(steadyNowMs()).held == true);

    // Let the TTL lapse with no traffic at all: no release, no renew, no
    // disconnect -- exactly the case that had no code path to react to it.
    std::this_thread::sleep_for(std::chrono::milliseconds(80));

    // The truth has already changed...
    CHECK(server.leases().holder(steadyNowMs()).held == false);
    // ...and before the periodic refresh existed, the hint had not.
    server.refreshLeaseHint();
    CHECK(server.leaseHeldHint() == false);
}

TEST_CASE("lease hint follows an ordinary acquire and release") {
    BridgeServer server;
    CHECK(server.leaseHeldHint() == false);
    std::string leaseId;
    REQUIRE(server.leases().acquire(7, "test-client", steadyNowMs(), 60000, leaseId) ==
            LeaseManager::AcquireResult::Ok);
    server.refreshLeaseHint();
    CHECK(server.leaseHeldHint() == true);
    CHECK(server.leases().release(7, leaseId) == true);
    server.refreshLeaseHint();
    CHECK(server.leaseHeldHint() == false);
}
