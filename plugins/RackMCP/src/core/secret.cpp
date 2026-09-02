#include "core/secret.hpp"
#include "core/crypto.hpp"

#include <cstdio>
#include <cstring>
#include <fstream>
#include <sstream>

#if defined(_WIN32)
#include <io.h>
#include <process.h>
#include <cstdio>
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <direct.h>
#else
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#include <fcntl.h>
#endif

namespace rackmcp {

/** Zeroization the optimizer cannot elide (a plain memset before return is a dead store). */
static void secureZero(void* p, size_t n) {
#if defined(_WIN32)
    SecureZeroMemory(p, n);
#else
    volatile unsigned char* v = (volatile unsigned char*) p;
    while (n--)
        *v++ = 0;
#endif
}

#if defined(_WIN32)
std::wstring utf8ToWide(const std::string& utf8) {
    if (utf8.empty())
        return std::wstring();
    int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8.data(), (int) utf8.size(), NULL, 0);
    if (n <= 0)
        return std::wstring();
    std::wstring w((size_t) n, L'\0');
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8.data(), (int) utf8.size(), &w[0], n);
    return w;
}

static bool applyOwnerOnlyAcl(const std::string& path) {
    // D:P(A;OICI;FA;;;OW) = protected DACL (nothing inherited from the parent),
    // full access for the object owner only, inherited by children.
    std::wstring wpath = utf8ToWide(path);
    if (wpath.empty())
        return false;
    PSECURITY_DESCRIPTOR sd = NULL;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
            L"D:P(A;OICI;FA;;;OW)", SDDL_REVISION_1, &sd, NULL))
        return false;
    BOOL present = FALSE, defaulted = FALSE;
    PACL dacl = NULL;
    bool ok = false;
    if (GetSecurityDescriptorDacl(sd, &present, &dacl, &defaulted) && present) {
        ok = SetNamedSecurityInfoW(&wpath[0], SE_FILE_OBJECT,
                                   DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                                   NULL, NULL, dacl, NULL) == ERROR_SUCCESS;
    }
    LocalFree(sd);
    return ok;
}
#endif

bool ensurePrivateDirectory(const std::string& dirPath) {
#if defined(_WIN32)
    std::wstring wdir = utf8ToWide(dirPath);
    if (wdir.empty())
        return false;
    if (_wmkdir(wdir.c_str()) != 0 && errno != EEXIST)
        return false;
    // Fail closed, like the POSIX chmod(0700) below: a directory whose ACL we
    // cannot tighten must not hold the pairing secret.
    return applyOwnerOnlyAcl(dirPath);
#else
    if (mkdir(dirPath.c_str(), 0700) != 0 && errno != EEXIST)
        return false;
    // Tighten an existing directory too.
    return chmod(dirPath.c_str(), 0700) == 0;
#endif
}

bool writePrivateFileAtomic(const std::string& path, const std::string& contents) {
    // Per-process temp name: two Rack instances sharing a user dir must never
    // clobber each other's in-flight write.
#if defined(_WIN32)
    std::string tmp = path + ".tmp." + std::to_string((long long) _getpid());
    std::wstring wtmp = utf8ToWide(tmp), wpath = utf8ToWide(path);
    if (wtmp.empty() || wpath.empty())
        return false;
    FILE* f = _wfopen(wtmp.c_str(), L"wb");
    if (!f)
        return false;
    bool ok = fwrite(contents.data(), 1, contents.size(), f) == contents.size();
    ok = ok && fflush(f) == 0;
    if (ok) {
        HANDLE h = (HANDLE) _get_osfhandle(_fileno(f));
        if (h != INVALID_HANDLE_VALUE)
            FlushFileBuffers(h);
    }
    if (fclose(f) != 0)
        ok = false;
    // The file inherited the directory's owner-only ACE at creation; pin an
    // explicit protected DACL on it as well, and fail closed if that is refused.
    if (!ok || !applyOwnerOnlyAcl(tmp)) {
        DeleteFileW(wtmp.c_str());
        return false;
    }
    // MoveFileEx with replace is atomic on the same volume (rename() would
    // fail on Windows when the destination exists).
    if (!MoveFileExW(wtmp.c_str(), wpath.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
        DeleteFileW(wtmp.c_str());
        return false;
    }
    return true;
#else
    std::string tmp = path + ".tmp." + std::to_string((long long) getpid());
    int fd = open(tmp.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (fd < 0)
        return false;
    size_t written = 0;
    while (written < contents.size()) {
        ssize_t n = write(fd, contents.data() + written, contents.size() - written);
        if (n <= 0) {
            close(fd);
            unlink(tmp.c_str());
            return false;
        }
        written += (size_t) n;
    }
    if (fsync(fd) != 0) {
        close(fd);
        unlink(tmp.c_str());
        return false;
    }
    close(fd);
    if (rename(tmp.c_str(), path.c_str()) != 0) {
        unlink(tmp.c_str());
        return false;
    }
    return true;
#endif
}

static std::string secretPath(const std::string& dirPath) {
#if defined(_WIN32)
    return dirPath + "\\secret";
#else
    return dirPath + "/secret";
#endif
}

static bool readSecretFile(const std::string& path, std::string& secretOut) {
    std::string hex;
#if defined(_WIN32)
    std::wstring wpath = utf8ToWide(path);
    if (wpath.empty())
        return false;
    FILE* f = _wfopen(wpath.c_str(), L"rb");
    if (!f)
        return false;
    char buf[256];
    size_t n;
    while ((n = fread(buf, 1, sizeof(buf), f)) > 0)
        hex.append(buf, n);
    fclose(f);
#else
    std::ifstream f(path.c_str(), std::ios::binary);
    if (!f)
        return false;
    std::stringstream ss;
    ss << f.rdbuf();
    hex = ss.str();
#endif
    // Trim trailing whitespace/newline.
    while (!hex.empty() && (hex.back() == '\n' || hex.back() == '\r' || hex.back() == ' '))
        hex.pop_back();
    if (hex.size() != 64)
        return false;
    std::string raw;
    if (!fromHex(hex, raw) || raw.size() != 32)
        return false;
    secretOut = raw;
    return true;
}

static bool generateSecret(const std::string& dirPath, std::string& secretOut) {
    uint8_t raw[32];
    if (!randomBytes(raw, sizeof(raw)))
        return false;
    std::string hex = toHex(raw, sizeof(raw));
    bool written = writePrivateFileAtomic(secretPath(dirPath), hex + "\n");
    secureZero(&hex[0], hex.size());
    if (!written) {
        secureZero(raw, sizeof(raw));
        return false;
    }
#if !defined(_WIN32)
    chmod(secretPath(dirPath).c_str(), 0600);
#endif
    secretOut.assign((const char*) raw, sizeof(raw));
    secureZero(raw, sizeof(raw));
    return true;
}

bool loadOrCreateSecret(const std::string& dirPath, std::string& secretOut, bool& created) {
    created = false;
    if (!ensurePrivateDirectory(dirPath))
        return false;
    if (readSecretFile(secretPath(dirPath), secretOut)) {
#if !defined(_WIN32)
        chmod(secretPath(dirPath).c_str(), 0600);
#endif
        return true;
    }
    created = true;
    return generateSecret(dirPath, secretOut);
}

bool rotateSecret(const std::string& dirPath, std::string& secretOut) {
    if (!ensurePrivateDirectory(dirPath))
        return false;
    return generateSecret(dirPath, secretOut);
}

} // namespace rackmcp
