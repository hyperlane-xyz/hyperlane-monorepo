#!/bin/bash
# Fast local builds using volume mounts (for development)
# Usage: ./build-mounted.sh [all|core|token]
#
# This script uses a cached Docker environment image and mounts the source
# code as volumes, which is faster for iterative development but requires
# Docker to support volume mounts (not available in CI environments).
#
# For reproducible CI builds, use build.sh instead.
#
# Examples:
#   ./build-mounted.sh all     # Build all programs
#   ./build-mounted.sh token   # Build token programs only
#   ./build-mounted.sh core    # Build core programs only

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

PROGRAM_TYPE="${1:-all}"
IMAGE_NAME="hyperlane-sealevel-env"

echo "========================================"
echo "Fast Local Build (Volume Mounted)"
echo "========================================"
echo "Program type: ${PROGRAM_TYPE}"
echo "Repository root: ${REPO_ROOT}"
echo ""

# Build base environment image (cached after first build)
echo "Building/checking environment image..."
docker build \
    --platform linux/amd64 \
    -f "${SCRIPT_DIR}/Dockerfile.env" \
    -t "${IMAGE_NAME}:latest" \
    "${SCRIPT_DIR}"

echo ""
echo "Running build with mounted source..."
echo ""

# Run with mounted source
# - Mount main workspace as read-only (only hyperlane-core needed)
# - Mount sealevel workspace as read-write (for target directory)
docker run --rm \
    --platform linux/amd64 \
    -v "${REPO_ROOT}/rust/main:/build/rust/main:ro" \
    -v "${REPO_ROOT}/rust/sealevel:/build/rust/sealevel" \
    -w /build/rust/sealevel/programs \
    -e SOURCE_DATE_EPOCH=0 \
    -e CARGO_INCREMENTAL=0 \
    -e CARGO_BUILD_SBF_LOCKED=1 \
    -e RUSTFLAGS="--cfg tokio_unstable" \
    "${IMAGE_NAME}:latest" \
    ./build-programs.sh "${PROGRAM_TYPE}"

# List built programs
OUTPUT_DIR="${REPO_ROOT}/rust/sealevel/target/deploy"
echo ""
echo "========================================"
echo "Built Programs"
echo "========================================"
for so_file in "${OUTPUT_DIR}"/*.so; do
    if [ -f "$so_file" ]; then
        filename=$(basename "$so_file")
        hash=$(sha256sum "$so_file" | cut -d' ' -f1)
        echo "${filename}"
        echo "  SHA256: ${hash}"
    fi
done

echo ""
echo "Programs built to: ${OUTPUT_DIR}"
