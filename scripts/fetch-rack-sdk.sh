#!/usr/bin/env bash
# Fetches and verifies the pinned VCV Rack SDK into vendor/Rack-SDK.
set -euo pipefail
cd "$(dirname "$0")/.."

RACK_SDK_VERSION="2.6.6"
case "${1:-$(uname -s)-$(uname -m)}" in
  Darwin-arm64|mac-arm64) PLATFORM="mac-arm64"; SHA256="29414e52417992cbafa47e30f947c3c0c7a34e5c424bb83c5a0af8c24840481f" ;;
  Darwin-x86_64|mac-x64)  PLATFORM="mac-x64";   SHA256="" ;;
  Linux-x86_64|lin-x64)   PLATFORM="lin-x64";   SHA256="420da2452def7b195f98e3a0650c35f1e0f058a98a71840b4347d3d203618532" ;;
  win-x64|MINGW*|MSYS*)   PLATFORM="win-x64";   SHA256="" ;;
  *) echo "unsupported platform: ${1:-$(uname -s)-$(uname -m)}" >&2; exit 1 ;;
esac

# Portable SHA-256: coreutils `sha256sum` (Linux, MSYS2, Git-bash) or Perl `shasum` (macOS).
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else echo "no sha256 tool found (need sha256sum or shasum)" >&2; return 1
  fi
}

ZIP="Rack-SDK-${RACK_SDK_VERSION}-${PLATFORM}.zip"
URL="https://vcvrack.com/downloads/${ZIP}"
mkdir -p vendor
if [ ! -d vendor/Rack-SDK ]; then
  echo "Downloading ${URL}" >&2
  curl -fsSL -o "vendor/${ZIP}" "${URL}"
  ACTUAL="$(sha256_of "vendor/${ZIP}")"
  if [ -n "${SHA256}" ]; then
    if [ "${ACTUAL}" != "${SHA256}" ]; then
      echo "sha256 mismatch for ${ZIP}: expected ${SHA256}, got ${ACTUAL}" >&2
      exit 1
    fi
    echo "sha256 verified for ${ZIP}" >&2
  else
    echo "WARNING: no pinned sha256 for ${PLATFORM}; recording actual: ${ACTUAL}" >&2
  fi
  (cd vendor && unzip -q "${ZIP}")
fi
echo "Rack SDK ${RACK_SDK_VERSION} (${PLATFORM}) ready at vendor/Rack-SDK" >&2
