// Exercises the secret-file and discovery-manifest code on a real filesystem,
// beneath a directory whose name is NON-ASCII (UTF-8 for "tést-日本"), so the
// Windows UTF-16 path handling is proven wherever this runs. Requires jansson
// (manifest JSON), like the service tests.
#include <doctest.h>
#include <jansson.h>
#include <cstdio>
#include <cstring>
#include <string>
#include "core/secret.hpp"
#include "core/manifest.hpp"

#if defined(_WIN32)
#include <process.h>
#define RMCP_TEST_PID _getpid()
#else
#include <sys/stat.h>
#include <unistd.h>
#define RMCP_TEST_PID getpid()
#endif

using namespace rackmcp;

namespace {

const std::string kDir = std::string(RACKMCP_TEST_SCRATCH) + "/RackMCP-t\xC3\xA9st-\xE6\x97\xA5\xE6\x9C\xAC";

std::string readAll(const std::string& path, bool& ok) {
    ok = false;
#if defined(_WIN32)
    std::wstring w = utf8ToWide(path);
    FILE* f = w.empty() ? NULL : _wfopen(w.c_str(), L"rb");
#else
    FILE* f = std::fopen(path.c_str(), "rb");
#endif
    if (!f)
        return std::string();
    std::string out;
    char buf[512];
    size_t n;
    while ((n = std::fread(buf, 1, sizeof(buf), f)) > 0)
        out.append(buf, n);
    std::fclose(f);
    ok = true;
    return out;
}

bool exists(const std::string& path) {
    bool ok;
    readAll(path, ok);
    return ok;
}

#if !defined(_WIN32)
int modeBits(const std::string& path) {
    struct stat st;
    if (stat(path.c_str(), &st) != 0)
        return -1;
    return (int) (st.st_mode & 0777);
}
#endif

} // namespace

TEST_CASE("ensurePrivateDirectory creates a non-ASCII directory, idempotently, owner-only") {
    REQUIRE(ensurePrivateDirectory(kDir));
    CHECK(ensurePrivateDirectory(kDir));
#if !defined(_WIN32)
    CHECK(modeBits(kDir) == 0700);
#endif
}

TEST_CASE("writePrivateFileAtomic writes, replaces atomically, leaves no temp file") {
    REQUIRE(ensurePrivateDirectory(kDir));
    const std::string path = kDir + "/atomic.txt";
    REQUIRE(writePrivateFileAtomic(path, "hello"));
    bool ok;
    CHECK(readAll(path, ok) == "hello");
    CHECK(ok);
    // Replace an existing destination (rename() would refuse this on Windows).
    REQUIRE(writePrivateFileAtomic(path, "hello, again"));
    CHECK(readAll(path, ok) == "hello, again");
    // The per-process temp name must be gone after the rename.
    CHECK_FALSE(exists(path + ".tmp." + std::to_string((long long) RMCP_TEST_PID)));
#if !defined(_WIN32)
    CHECK(modeBits(path) == 0600);
#endif
}

TEST_CASE("loadOrCreateSecret creates once, round-trips through the hex file, rotates, self-heals") {
    REQUIRE(ensurePrivateDirectory(kDir));
    const std::string secretFile = kDir + "/secret";
    std::remove(secretFile.c_str());
#if defined(_WIN32)
    { std::wstring w = utf8ToWide(secretFile); if (!w.empty()) _wremove(w.c_str()); }
#endif

    std::string s1, s2, s3;
    bool created = false;
    REQUIRE(loadOrCreateSecret(kDir, s1, created));
    CHECK(created);
    CHECK(s1.size() == 32);

    bool ok;
    std::string onDisk = readAll(secretFile, ok);
    REQUIRE(ok);
    CHECK(onDisk.size() == 65); // 64 hex chars + newline
    CHECK(onDisk[64] == '\n');
    CHECK(onDisk.find_first_not_of("0123456789abcdef") == 64);
#if !defined(_WIN32)
    CHECK(modeBits(secretFile) == 0600);
#endif

    REQUIRE(loadOrCreateSecret(kDir, s2, created));
    CHECK_FALSE(created);
    CHECK(s2 == s1);

    REQUIRE(rotateSecret(kDir, s3));
    CHECK(s3.size() == 32);
    CHECK(s3 != s1);
    std::string s4;
    REQUIRE(loadOrCreateSecret(kDir, s4, created));
    CHECK_FALSE(created);
    CHECK(s4 == s3);

    // A corrupt file is replaced with a fresh secret rather than trusted.
    REQUIRE(writePrivateFileAtomic(secretFile, "not-hex-at-all\n"));
    std::string s5;
    REQUIRE(loadOrCreateSecret(kDir, s5, created));
    CHECK(created);
    CHECK(s5.size() == 32);
    CHECK(s5 != s3);
}

TEST_CASE("manifest is written atomically, rewritten in place, parseable, secret-free, and removable") {
    const std::string instancesDir = kDir + "/instances";
    ManifestData d;
    d.instanceId = "11111111-2222-4333-8444-555555555555";
    d.pid = (int64_t) RMCP_TEST_PID;
    d.rackVersion = "2.6.6";
    d.rackEdition = "Pro";
    d.bridgeVersion = "0.1.0-test";
    d.port = 51763;
    d.startTimeIso = isoNowUtc();
    d.lastHeartbeatIso = d.startTimeIso;
    d.userDir = kDir;
    d.patchesDir = kDir + "/patches";
    d.checkpointsDir = kDir + "/RackMCP/checkpoints";

    REQUIRE(writeManifest(instancesDir, d));
    const std::string file = instancesDir + "/" + d.instanceId + ".json";
    bool ok;
    std::string text = readAll(file, ok);
    REQUIRE(ok);
    json_error_t err;
    json_t* root = json_loads(text.c_str(), 0, &err);
    REQUIRE(root);
    CHECK(json_integer_value(json_object_get(root, "manifestVersion")) == 1);
    CHECK(std::string(json_string_value(json_object_get(root, "instanceId"))) == d.instanceId);
    CHECK(json_integer_value(json_object_get(root, "pid")) == d.pid);
    CHECK(json_integer_value(json_object_get(root, "port")) == 51763);
    CHECK(json_is_null(json_object_get(root, "patchName")));
    CHECK((json_object_get(root, "secret") == NULL)); // parenthesised: no doctest decomposition of a pointer
    CHECK(std::string(json_string_value(json_object_get(root, "userDir"))) == kDir);
    json_decref(root);

    // Heartbeat rewrite replaces the existing file.
    d.lastHeartbeatIso = "2030-01-01T00:00:00.000Z";
    d.patchName = "Untitled";
    REQUIRE(writeManifest(instancesDir, d));
    text = readAll(file, ok);
    REQUIRE(ok);
    CHECK(text.find("2030-01-01T00:00:00.000Z") != std::string::npos);
    CHECK(text.find("\"patchName\":\"Untitled\"") != std::string::npos);

    removeManifest(instancesDir, d.instanceId);
    CHECK_FALSE(exists(file));
}

TEST_CASE("isoNowUtc is ISO-8601 UTC with milliseconds") {
    std::string t = isoNowUtc();
    CHECK(t.size() == 24);
    CHECK(t[10] == 'T');
    CHECK(t[23] == 'Z');
    CHECK(t[19] == '.');
}
