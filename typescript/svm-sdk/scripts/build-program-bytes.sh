#!/usr/bin/env bash
set -euo pipefail

# Local path dependencies influence Rust crate disambiguators and ELF ordering.
# Use the same source path and distributed compiler host locally and in CI.
REPO_ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
source "$REPO_ROOT/rust/sealevel/programs/toolchain.env"
BUILD_ROOT=/tmp/hyperlane-sealevel-program-bytes
if [[ "$(uname -s)/$(uname -m)" != "Darwin/arm64" ]]; then
  echo 'Embedded program bytes require the canonical macOS arm64 build host.' >&2
  exit 1
fi
if [[ "$(solana --version | awk '{print $2}')" != "$SOLANA_CLI_VERSION_FOR_BUILDING_PROGRAMS" ]]; then
  echo "Install Agave $SOLANA_CLI_VERSION_FOR_BUILDING_PROGRAMS and put its bin directory on PATH before building." >&2
  exit 1
fi
# Fail on an existing build, rather than deleting another process's workspace.
mkdir "$BUILD_ROOT"
trap 'rm -rf "$BUILD_ROOT"' EXIT
rsync -a --exclude target --exclude .git "$REPO_ROOT/rust/" "$BUILD_ROOT/rust/"
unset RUSTFLAGS CARGO_ENCODED_RUSTFLAGS
export CARGO_TARGET_DIR="$BUILD_ROOT/rust/sealevel/target"
(
  cd "$BUILD_ROOT/rust/sealevel/programs"
  bash build-programs.sh
)
mkdir -p "$REPO_ROOT/rust/sealevel/target/deploy"
cp "$BUILD_ROOT"/rust/sealevel/target/deploy/*.so "$REPO_ROOT/rust/sealevel/target/deploy/"
