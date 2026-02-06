#!/bin/bash
# Build Solana programs reproducibly using Docker
# Usage: ./build.sh [all|core|token] [tag]
#
# This script builds Solana programs in a deterministic Docker environment,
# producing .so files with consistent hashes across builds.
#
# Examples:
#   ./build.sh all          # Build all programs
#   ./build.sh token        # Build token programs only
#   ./build.sh core         # Build core programs only
#   ./build.sh all v1.0.0   # Build with specific tag

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

PROGRAM_TYPE="${1:-all}"
TAG="${2:-latest}"
IMAGE_NAME="hyperlane-sealevel-build"

echo "========================================"
echo "Reproducible Solana Program Build"
echo "========================================"
echo "Program type: ${PROGRAM_TYPE}"
echo "Image tag: ${TAG}"
echo "Repository root: ${REPO_ROOT}"
echo ""

# Build the Docker image from repo root (needed for build context)
# Use --target builder to stop at builder stage (allows extracting files)
echo "Building Docker image..."
docker build \
    --progress=plain \
    --platform linux/amd64 \
    --build-arg PROGRAM_TYPE="${PROGRAM_TYPE}" \
    --target builder \
    -f "${SCRIPT_DIR}/Dockerfile" \
    -t "${IMAGE_NAME}:${TAG}" \
    "${REPO_ROOT}"

# Create output directory
OUTPUT_DIR="${REPO_ROOT}/rust/sealevel/target/deploy-reproducible"
mkdir -p "${OUTPUT_DIR}"

# Extract .so files from the build container
echo ""
echo "Extracting built programs to ${OUTPUT_DIR}..."

# Create temporary container to extract files
CONTAINER_ID=$(docker create "${IMAGE_NAME}:${TAG}" /bin/true)

# Copy files from container
docker cp "${CONTAINER_ID}:/build/rust/sealevel/target/deploy/." "${OUTPUT_DIR}/"

# Cleanup container
docker rm "${CONTAINER_ID}" > /dev/null

# List built programs and their hashes
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
echo "Programs extracted to: ${OUTPUT_DIR}"
echo ""
echo "To verify with solana-verify:"
echo "  solana-verify get-executable-hash ${OUTPUT_DIR}/<program>.so"
