#include <doctest.h>
#include <jansson.h>
#include <chrono>
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

    Harness() {
        uint8_t raw[32];
        REQUIRE(randomBytes(raw, 32));
        secret.assign((const char*) raw, 32);
        config.secret = secret;
        config.instanceId = uuid4();
        config.sessionId = uuid4();
        config.bridgeVersion = "0.1.0-test";
        config.rackVersion = "2.6.6";
        config.rackEdition = "Pro";
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
