#include "core/tcp.hpp"

#include <cstring>

#if defined(_WIN32)
#include <winsock2.h>
#include <ws2tcpip.h>
#pragma comment(lib, "ws2_32.lib")
typedef int socklen_t;
#define RMCP_CLOSESOCK closesocket
#define RMCP_SHUT_RDWR SD_BOTH
#else
#include <arpa/inet.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#define RMCP_CLOSESOCK ::close
#define RMCP_SHUT_RDWR SHUT_RDWR
#endif

// Native socket type for the C APIs: SOCKET (UINT_PTR) on Windows, int elsewhere.
#if defined(_WIN32)
#define RMCP_SOCK(h) ((SOCKET) (h))
#else
#define RMCP_SOCK(h) ((int) (h))
#endif
// Never let a peer that vanished mid-write raise SIGPIPE and kill the host
// process: MSG_NOSIGNAL on Linux, SO_NOSIGPIPE (set per socket) on macOS/BSD;
// Windows has no SIGPIPE.
#if defined(MSG_NOSIGNAL) && !defined(_WIN32)
#define RMCP_SEND_FLAGS MSG_NOSIGNAL
#else
#define RMCP_SEND_FLAGS 0
#endif

namespace rackmcp {

const SocketHandle INVALID_SOCKET_HANDLE = (SocketHandle) -1;

bool socketsInit() {
#if defined(_WIN32)
    WSADATA data;
    return WSAStartup(MAKEWORD(2, 2), &data) == 0;
#else
    return true;
#endif
}

void socketsShutdown() {
#if defined(_WIN32)
    WSACleanup();
#endif
}

static bool waitReadable(SocketHandle fd, int timeoutMs) {
#if defined(_WIN32)
    fd_set rfds;
    FD_ZERO(&rfds);
    FD_SET((SOCKET) fd, &rfds);
    timeval tv;
    tv.tv_sec = timeoutMs / 1000;
    tv.tv_usec = (timeoutMs % 1000) * 1000;
    int r = select(0, &rfds, NULL, NULL, &tv);
    return r > 0;
#else
    pollfd p;
    p.fd = fd;
    p.events = POLLIN;
    p.revents = 0;
    int r = poll(&p, 1, timeoutMs);
    return r > 0 && (p.revents & (POLLIN | POLLHUP | POLLERR));
#endif
}

bool TcpListener::listen(uint16_t port) {
    close();
    SocketHandle fd = (SocketHandle) socket(AF_INET, SOCK_STREAM, 0);
    if (fd == INVALID_SOCKET_HANDLE)
        return false;
    int yes = 1;
#if defined(_WIN32)
    // On Windows SO_REUSEADDR lets ANY local process bind the same port while we
    // are listening (port hijacking); SO_EXCLUSIVEADDRUSE is the safe default.
    setsockopt(RMCP_SOCK(fd), SOL_SOCKET, SO_EXCLUSIVEADDRUSE, (const char*) &yes, sizeof(yes));
#else
    setsockopt(RMCP_SOCK(fd), SOL_SOCKET, SO_REUSEADDR, (const char*) &yes, sizeof(yes));
#endif
    sockaddr_in addr;
    std::memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    // Loopback only. Never INADDR_ANY.
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = htons(port);
    if (bind(RMCP_SOCK(fd), (sockaddr*) &addr, sizeof(addr)) != 0) {
        RMCP_CLOSESOCK(RMCP_SOCK(fd));
        return false;
    }
    if (::listen(RMCP_SOCK(fd), 8) != 0) {
        RMCP_CLOSESOCK(RMCP_SOCK(fd));
        return false;
    }
    socklen_t len = sizeof(addr);
    if (getsockname(RMCP_SOCK(fd), (sockaddr*) &addr, &len) != 0) {
        RMCP_CLOSESOCK(RMCP_SOCK(fd));
        return false;
    }
    fd_.store(fd);
    port_ = ntohs(addr.sin_port);
    return true;
}

SocketHandle TcpListener::accept(int timeoutMs) {
    SocketHandle fd = fd_.load();
    if (fd == INVALID_SOCKET_HANDLE)
        return INVALID_SOCKET_HANDLE;
    if (!waitReadable(fd, timeoutMs))
        return INVALID_SOCKET_HANDLE;
    sockaddr_in peer;
    socklen_t len = sizeof(peer);
    SocketHandle client = (SocketHandle) ::accept(RMCP_SOCK(fd), (sockaddr*) &peer, &len);
    if (client == INVALID_SOCKET_HANDLE)
        return INVALID_SOCKET_HANDLE;
    // Defense in depth: refuse non-loopback peers even though we bind loopback.
    if (peer.sin_addr.s_addr != htonl(INADDR_LOOPBACK)) {
        RMCP_CLOSESOCK(RMCP_SOCK(client));
        return INVALID_SOCKET_HANDLE;
    }
    int yes = 1;
    setsockopt(RMCP_SOCK(client), IPPROTO_TCP, TCP_NODELAY, (const char*) &yes, sizeof(yes));
#if defined(SO_NOSIGPIPE)
    setsockopt(RMCP_SOCK(client), SOL_SOCKET, SO_NOSIGPIPE, (const char*) &yes, sizeof(yes));
#endif
    return client;
}

bool TcpListener::isOpen() const {
    return fd_.load() != INVALID_SOCKET_HANDLE;
}

void TcpListener::close() {
    SocketHandle fd = fd_.exchange(INVALID_SOCKET_HANDLE);
    if (fd != INVALID_SOCKET_HANDLE) {
        shutdown(RMCP_SOCK(fd), RMCP_SHUT_RDWR);
        RMCP_CLOSESOCK(RMCP_SOCK(fd));
    }
}

int TcpStream::read(uint8_t* buf, size_t maxLen, int timeoutMs) {
    timedOut_ = false;
    SocketHandle fd = fd_.load();
    if (fd == INVALID_SOCKET_HANDLE)
        return -1;
    if (!waitReadable(fd, timeoutMs)) {
        timedOut_ = true;
        return 0;
    }
    int n = (int) recv(RMCP_SOCK(fd), (char*) buf, (int) maxLen, 0);
    return n;
}

bool TcpStream::writeAll(const void* buf, size_t len) {
    SocketHandle fd = fd_.load();
    if (fd == INVALID_SOCKET_HANDLE)
        return false;
    const char* p = (const char*) buf;
    size_t sent = 0;
    while (sent < len) {
        int n = (int) send(RMCP_SOCK(fd), p + sent, (int) (len - sent), RMCP_SEND_FLAGS);
        if (n <= 0)
            return false;
        sent += (size_t) n;
    }
    return true;
}

bool TcpStream::isOpen() const {
    return fd_.load() != INVALID_SOCKET_HANDLE;
}

void TcpStream::close() {
    SocketHandle fd = fd_.exchange(INVALID_SOCKET_HANDLE);
    if (fd != INVALID_SOCKET_HANDLE) {
        shutdown(RMCP_SOCK(fd), RMCP_SHUT_RDWR);
        RMCP_CLOSESOCK(RMCP_SOCK(fd));
    }
}

SocketHandle tcpConnectLoopback(uint16_t port, int timeoutMs) {
    (void) timeoutMs;
    SocketHandle fd = (SocketHandle) socket(AF_INET, SOCK_STREAM, 0);
    if (fd == INVALID_SOCKET_HANDLE)
        return INVALID_SOCKET_HANDLE;
    sockaddr_in addr;
    std::memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = htons(port);
    if (connect(RMCP_SOCK(fd), (sockaddr*) &addr, sizeof(addr)) != 0) {
        RMCP_CLOSESOCK(RMCP_SOCK(fd));
        return INVALID_SOCKET_HANDLE;
    }
    int yes = 1;
    setsockopt(RMCP_SOCK(fd), IPPROTO_TCP, TCP_NODELAY, (const char*) &yes, sizeof(yes));
#if defined(SO_NOSIGPIPE)
    setsockopt(RMCP_SOCK(fd), SOL_SOCKET, SO_NOSIGPIPE, (const char*) &yes, sizeof(yes));
#endif
    return fd;
}

} // namespace rackmcp
