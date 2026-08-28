#!/usr/bin/env bash
# Fetches and verifies the pinned VCV Rack SDK into vendor/Rack-SDK.
set -euo pipefail
cd "$(dirname "$0")/.."

RACK_SDK_VERSION="2.6.6"
case "${1:-$(uname -s)-$(uname -m)}" in
  Darwin-arm64|mac-arm64) PLATFORM="mac-arm64"; SHA256="29414e52417992cbafa47e30f947c3c0c7a34e5c424bb83c5a0af8c24840481f" ;;
  Darwin-x86_64|mac-x64)  PLATFORM="mac-x64";   SHA256="" ;;
  Linux-x86_64|lin-x64)   PLATFORM="lin-x64";   SHA256="" ;;
  win-x64|MINGW*|MSYS*)   PLATFORM="win-x64";   SHA256="" ;;
  *) echo "unsupported platform: ${1:-$(uname -s)-$(uname -m)}" >&2; exit 1 ;;
esac

ZIP="Rack-SDK-${RACK_SDK_VERSION}-${PLATFORM}.zip"
URL="https://vcvrack.com/downloads/${ZIP}"
mkdir -p vendor
if [ ! -d vendor/Rack-SDK ]; then
  echo "Downloading ${URL}" >&2
  curl -fsSL -o "vendor/${ZIP}" "${URL}"
  if [ -n "${SHA256}" ]; then
    echo "${SHA256}  vendor/${ZIP}" | shasum -a 256 -c -
  else
    echo "WARNING: no pinned sha256 for ${PLATFORM}; recording actual:" >&2
    shasum -a 256 "vendor/${ZIP}" >&2
  fi
  (cd vendor && unzip -q "${ZIP}")
fi
echo "Rack SDK ${RACK_SDK_VERSION} (${PLATFORM}) ready at vendor/Rack-SDK" >&2
