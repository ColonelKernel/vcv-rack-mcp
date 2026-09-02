#include "core/manifest.hpp"
#include "core/secret.hpp"

#include <cstdio>
#include <ctime>
#include <jansson.h>

#if defined(_WIN32)
#include <windows.h>
#else
#include <sys/time.h>
#include <unistd.h>
#endif

namespace rackmcp {

std::string isoNowUtc() {
    char buf[40];
#if defined(_WIN32)
    SYSTEMTIME st;
    GetSystemTime(&st);
    snprintf(buf, sizeof(buf), "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ", st.wYear, st.wMonth, st.wDay,
             st.wHour, st.wMinute, st.wSecond, st.wMilliseconds);
#else
    timeval tv;
    gettimeofday(&tv, NULL);
    struct tm tmv;
    gmtime_r(&tv.tv_sec, &tmv);
    snprintf(buf, sizeof(buf), "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ", tmv.tm_year + 1900,
             tmv.tm_mon + 1, tmv.tm_mday, tmv.tm_hour, tmv.tm_min, tmv.tm_sec,
             (int) (tv.tv_usec / 1000));
#endif
    return buf;
}

std::string manifestToJson(const ManifestData& d) {
    json_t* o = json_pack(
        "{s:i, s:s, s:I, s:s, s:s, s:s, s:i, s:i, s:s, s:s, s:s, s:o, s:b, s:b, s:s, s:s, s:s}",
        "manifestVersion", 1,
        "instanceId", d.instanceId.c_str(),
        "pid", (json_int_t) d.pid,
        "rackVersion", d.rackVersion.c_str(),
        "rackEdition", d.rackEdition.c_str(),
        "bridgeVersion", d.bridgeVersion.c_str(),
        "bridgeProtocolVersion", d.bridgeProtocolVersion,
        "port", d.port,
        "startTime", d.startTimeIso.c_str(),
        "lastHeartbeat", d.lastHeartbeatIso.c_str(),
        "mode", "standalone-gui",
        "patchName", d.patchName.empty() ? json_null() : json_string(d.patchName.c_str()),
        "commandPumpPresent", d.commandPumpPresent ? 1 : 0,
        "bridgeModulePresent", d.bridgeModulePresent ? 1 : 0,
        "userDir", d.userDir.c_str(),
        "patchesDir", d.patchesDir.c_str(),
        "checkpointsDir", d.checkpointsDir.c_str());
    if (!o)
        return std::string();
    char* s = json_dumps(o, JSON_COMPACT);
    std::string out = s ? s : "";
    if (s)
        free(s);
    json_decref(o);
    return out;
}

static std::string manifestPath(const std::string& instancesDir, const std::string& instanceId) {
#if defined(_WIN32)
    return instancesDir + "\\" + instanceId + ".json";
#else
    return instancesDir + "/" + instanceId + ".json";
#endif
}

bool writeManifest(const std::string& instancesDir, const ManifestData& data) {
    if (!ensurePrivateDirectory(instancesDir))
        return false;
    std::string doc = manifestToJson(data);
    if (doc.empty())
        return false;
    return writePrivateFileAtomic(manifestPath(instancesDir, data.instanceId), doc + "\n");
}

void removeManifest(const std::string& instancesDir, const std::string& instanceId) {
#if defined(_WIN32)
    std::wstring w = utf8ToWide(manifestPath(instancesDir, instanceId));
    if (!w.empty())
        DeleteFileW(w.c_str());
#else
    std::remove(manifestPath(instancesDir, instanceId).c_str());
#endif
}

} // namespace rackmcp
