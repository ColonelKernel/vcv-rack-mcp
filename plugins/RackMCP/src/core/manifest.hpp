#pragma once
// Discovery manifest writing (spec section 3.3). Never contains the secret.
// No Rack dependencies (jansson only); C++11; unit tested out of tree.
#include <cstdint>
#include <string>

namespace rackmcp {

struct ManifestData {
    std::string instanceId;
    int64_t pid = 0;
    std::string rackVersion;
    std::string rackEdition; // "Free" | "Pro" | "unknown"
    std::string bridgeVersion;
    int bridgeProtocolVersion = 1;
    int port = 0;
    std::string startTimeIso;
    std::string lastHeartbeatIso;
    std::string patchName; // empty => null
    bool commandPumpPresent = false;
    bool bridgeModulePresent = false;
    std::string userDir;
    std::string patchesDir;
    std::string checkpointsDir;
};

/** Serializes the manifest JSON document. */
std::string manifestToJson(const ManifestData& data);

/** Atomically writes <instancesDir>/<instanceId>.json (owner-only perms). */
bool writeManifest(const std::string& instancesDir, const ManifestData& data);

/** Removes the manifest file on clean shutdown. */
void removeManifest(const std::string& instancesDir, const std::string& instanceId);

/** Current wall-clock time as ISO-8601 UTC with milliseconds. */
std::string isoNowUtc();

} // namespace rackmcp
