#pragma once
// Minimal cross-platform loopback TCP. Binds only to 127.0.0.1 by design;
// there is deliberately no way to bind any other interface.
// No Rack dependencies; C++11; unit tested out of tree.
#include <cstdint>
#include <string>

namespace rackmcp {

#if defined(_WIN32)
typedef uintptr_t SocketHandle;
#else
typedef int SocketHandle;
#endif
extern const SocketHandle INVALID_SOCKET_HANDLE;

/** Process-wide socket subsystem init (WSAStartup on Windows; no-op elsewhere). */
bool socketsInit();
void socketsShutdown();

class TcpListener {
public:
    TcpListener() = default;
    ~TcpListener() { close(); }
    TcpListener(const TcpListener&) = delete;
    TcpListener& operator=(const TcpListener&) = delete;

    /** Binds 127.0.0.1:port (0 = ephemeral) and listens. */
    bool listen(uint16_t port);
    uint16_t port() const { return port_; }

    /**
     * Waits up to timeoutMs for a connection. Returns INVALID_SOCKET_HANDLE on
     * timeout or when the listener is closed (check isOpen()).
     */
    SocketHandle accept(int timeoutMs);

    bool isOpen() const;
    /** Thread-safe close; unblocks accept(). */
    void close();

private:
    SocketHandle fd_ = (SocketHandle) -1;
    uint16_t port_ = 0;
};

class TcpStream {
public:
    explicit TcpStream(SocketHandle fd) : fd_(fd) {}
    ~TcpStream() { close(); }
    TcpStream(const TcpStream&) = delete;
    TcpStream& operator=(const TcpStream&) = delete;

    /**
     * Reads up to maxLen bytes; waits up to timeoutMs. Returns >0 bytes read,
     * 0 on orderly shutdown or timeout (check timedOut()), <0 on error.
     */
    int read(uint8_t* buf, size_t maxLen, int timeoutMs);
    bool timedOut() const { return timedOut_; }

    /** Writes the whole buffer. Returns false on error. */
    bool writeAll(const void* buf, size_t len);

    bool isOpen() const;
    /** Thread-safe shutdown+close; unblocks read(). */
    void close();

private:
    SocketHandle fd_;
    bool timedOut_ = false;
};

/** Client-side connect to 127.0.0.1:port (tests and tooling). */
SocketHandle tcpConnectLoopback(uint16_t port, int timeoutMs);

} // namespace rackmcp
