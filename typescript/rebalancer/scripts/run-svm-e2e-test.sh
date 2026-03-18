#!/usr/bin/env bash
set -e

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
AGAVE_VERSION="3.0.14"
AGAVE_DIR="${REPO_ROOT}/.local-tools/agave-v${AGAVE_VERSION}"
SO_DIR="${REPO_ROOT}/rust/main/target/dist"

# Pre-flight checks
echo "Running pre-flight checks..."

docker info >/dev/null 2>&1 || { echo "Error: Docker is required (testcontainers uses it for Anvil EVM chains). Please start Docker Desktop." >&2; exit 1; }

command -v protoc >/dev/null 2>&1 || { echo "Error: protoc not found. Run: brew install protobuf" >&2; exit 1; }

command -v pkg-config >/dev/null 2>&1 || { echo "Error: pkg-config not found. Run: brew install pkg-config" >&2; exit 1; }

lsof -i :8899 -t >/dev/null 2>&1 && { echo "Error: Port 8899 is in use. Kill the process or stop any running Solana validator." >&2; exit 1; } || true

echo "Pre-flight checks passed."

# Detect platform for Agave binary
OS=$(uname -s)
ARCH=$(uname -m)
if [ "$OS" = "Darwin" ] && [ "$ARCH" = "arm64" ]; then
  AGAVE_PLATFORM="aarch64-apple-darwin"
elif [ "$OS" = "Darwin" ] && [ "$ARCH" = "x86_64" ]; then
  AGAVE_PLATFORM="x86_64-apple-darwin"
elif [ "$OS" = "Linux" ] && [ "$ARCH" = "x86_64" ]; then
  AGAVE_PLATFORM="x86_64-unknown-linux-gnu"
else
  echo "Error: Unsupported platform: $OS $ARCH" >&2
  exit 1
fi

# Step 1: Install Agave v3.0.14
if [ -f "${AGAVE_DIR}/bin/solana-test-validator" ]; then
  echo "Agave v${AGAVE_VERSION} already installed at ${AGAVE_DIR}"
else
  echo "Installing Agave v${AGAVE_VERSION}..."
  mkdir -p "${AGAVE_DIR}"
  curl -fSL "https://github.com/anza-xyz/agave/releases/download/v${AGAVE_VERSION}/solana-release-${AGAVE_PLATFORM}.tar.bz2" -o /tmp/agave.tar.bz2
  tar -xjf /tmp/agave.tar.bz2 -C /tmp
  mv /tmp/solana-release/* "${AGAVE_DIR}/"
  rm -rf /tmp/solana-release /tmp/agave.tar.bz2
  "${AGAVE_DIR}/bin/solana" --version
fi

# CRITICAL: Prepend Agave to PATH before any build steps
export PATH="${AGAVE_DIR}/bin:${PATH}"

# Step 2: Build Sealevel programs
if [ -f "${SO_DIR}/hyperlane_sealevel_mailbox.so" ]; then
  echo "Sealevel programs already built at ${SO_DIR}"
else
  echo "Building Sealevel programs (first run ~5-10 min)..."
  export SBF_OUT_PATH="${SO_DIR}"
  mkdir -p "${SO_DIR}"
  cd "${REPO_ROOT}/rust/sealevel/programs" && bash build-programs.sh
fi

# Step 3: Download SPL programs
if [ -f "${SO_DIR}/spl_token.so" ]; then
  echo "SPL programs already downloaded at ${SO_DIR}"
else
  echo "Downloading SPL programs..."
  mkdir -p "${SO_DIR}"
  curl -sL "https://github.com/hyperlane-xyz/solana-program-library/releases/download/2024-08-23/spl.tar.gz" | tar -xz -C "${SO_DIR}"
fi

# Step 4: Build sealevel client
if [ -f "${REPO_ROOT}/rust/sealevel/target/debug/hyperlane-sealevel-client" ]; then
  echo "hyperlane-sealevel-client already built"
else
  echo "Building hyperlane-sealevel-client..."
  cd "${REPO_ROOT}/rust/sealevel" && cargo build --package hyperlane-sealevel-client
fi

# Step 5: Build TypeScript (always run — turbo cache makes it fast)
echo "Building TypeScript..."
cd "${REPO_ROOT}" && pnpm build

# Step 6: Run tests
echo "Running mixed SVM+EVM collateral e2e tests..."
cd "${REPO_ROOT}/typescript/rebalancer"
pnpm mocha --extension ts --node-option='import=tsx/esm' --timeout 600000 --exit 'src/e2e/mixed-svm-evm-collateral.e2e-test.ts'
