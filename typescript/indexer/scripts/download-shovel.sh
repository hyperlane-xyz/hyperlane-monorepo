#!/usr/bin/env bash
set -euo pipefail

VERSION="${SHOVEL_VERSION:-main}"
OUT="${SHOVEL_BIN_OUT:-./shovel}"

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH_RAW="$(uname -m)"

case "${ARCH_RAW}" in
  x86_64|amd64)
    ARCH="amd64"
    ;;
  arm64|aarch64)
    ARCH="arm64"
    ;;
  *)
    echo "Unsupported architecture: ${ARCH_RAW}" >&2
    exit 1
    ;;
esac

case "${OS}" in
  linux|darwin)
    ;;
  *)
    echo "Unsupported OS: ${OS}" >&2
    exit 1
    ;;
esac

URL="https://indexsupply.net/bin/${VERSION}/${OS}/${ARCH}/shovel"

echo "Downloading shovel ${VERSION} from ${URL}"
curl -fL "${URL}" -o "${OUT}"
chmod +x "${OUT}"

echo "Shovel binary ready: ${OUT}"
