#pragma once
// Pairing secret storage beneath the Rack user folder.
// Directory mode 0700; secret file mode 0600 on POSIX. On Windows, files are
// created with an owner-only DACL. Secrets are raw 32 bytes stored hex-encoded.
// No Rack dependencies; C++11; unit tested out of tree.
#include <string>

namespace rackmcp {

/** Creates dirPath (mode 0700) if needed. Returns false on failure. */
bool ensurePrivateDirectory(const std::string& dirPath);

/**
 * Loads the pairing secret from <dirPath>/secret, creating a fresh 256-bit
 * random one when missing or invalid. Returns raw 32 bytes via secretOut.
 * `created` reports whether a new secret was generated.
 */
bool loadOrCreateSecret(const std::string& dirPath, std::string& secretOut, bool& created);

/** Deletes and regenerates the secret (pairing reset). */
bool rotateSecret(const std::string& dirPath, std::string& secretOut);

/** Writes a file atomically (temp + rename) with owner-only permissions. */
bool writePrivateFileAtomic(const std::string& path, const std::string& contents);

#if defined(_WIN32)
/** UTF-8 -> UTF-16 for Win32 *W APIs (Rack hands plugins UTF-8 paths). Empty on invalid input. */
std::wstring utf8ToWide(const std::string& utf8);
#endif

} // namespace rackmcp
