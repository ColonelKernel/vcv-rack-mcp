#include "core/secret.hpp"
#include "core/crypto.hpp"

#include <cstdio>
#include <cstring>
#include <fstream>
#include <sstream>

#if defined(_WIN32)
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

#if defined(_WIN32)
static bool applyOwnerOnlyAcl(const std::string& path) {
    // D:P(A;;FA;;;OW) = protected DACL, full access for object owner only.
    PSECURITY_DESCRIPTOR sd = NULL;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorA(
            "D:P(A;OICI;FA;;;OW)", SDDL_REVISION_1, &sd, NULL))
        return false;
    BOOL present = FALSE, defaulted = FALSE;
    PACL dacl = NULL;
    bool ok = false;
    if (GetSecurityDescriptorDacl(sd, &present, &dacl, &defaulted) && present) {
        ok = SetNamedSecurityInfoA((LPSTR) path.c_str(), SE_FILE_OBJECT,
                                   DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                                   NULL, NULL, dacl, NULL) == ERROR_SUCCESS;
    }
    LocalFree(sd);
    return ok;
}
#endif

bool ensurePrivateDirectory(const std::string& dirPath) {
#if defined(_WIN32)
    if (_mkdir(dirPath.c_str()) != 0 && errno != EEXIST)
        return false;
    applyOwnerOnlyAcl(dirPath);
    return true;
#else
    if (mkdir(dirPath.c_str(), 0700) != 0 && errno != EEXIST)
        return false;
    // Tighten an existing directory too.
    return chmod(dirPath.c_str(), 0700) == 0;
#endif
}

bool writePrivateFileAtomic(const std::string& path, const std::string& contents) {
    std::string tmp = path + ".tmp";
#if defined(_WIN32)
    {
        std::ofstream f(tmp.c_str(), std::ios::binary | std::ios::trunc);
        if (!f)
            return false;
        f.write(contents.data(), (std::streamsize) contents.size());
        if (!f)
            return false;
    }
    applyOwnerOnlyAcl(tmp);
    // MoveFileEx with replace is atomic on the same volume.
    if (!MoveFileExA(tmp.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING)) {
        DeleteFileA(tmp.c_str());
        return false;
    }
    return true;
#else
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
    std::ifstream f(path.c_str(), std::ios::binary);
    if (!f)
        return false;
    std::stringstream ss;
    ss << f.rdbuf();
    std::string hex = ss.str();
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
    if (!writePrivateFileAtomic(secretPath(dirPath), hex + "\n"))
        return false;
#if !defined(_WIN32)
    chmod(secretPath(dirPath).c_str(), 0600);
#endif
    secretOut.assign((const char*) raw, sizeof(raw));
    // Best-effort scrub of the stack copy.
    std::memset(raw, 0, sizeof(raw));
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
