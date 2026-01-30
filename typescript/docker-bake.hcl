# Bake configuration for Hyperlane TypeScript service Docker images
# https://depot.dev/docs/container-builds/how-to-guides/docker-bake
#
# This file defines all TypeScript service targets for parallel builds with shared caching.
# Usage: depot bake --file typescript/docker-bake.hcl

# Variables passed from CI
variable "TAG" {
  default = "latest"
}

variable "TAG_SHA_DATE" {
  default = ""
}

variable "PLATFORMS" {
  default = "linux/amd64"
}

variable "FOUNDRY_VERSION" {
  default = ""
}

variable "SERVICE_VERSION" {
  default = ""
}

# Registry prefix for all images
variable "REGISTRY" {
  default = "gcr.io/abacus-labs-dev"
}

# Default group builds all targets
group "default" {
  targets = ["ncc-services"]
}

# NCC-bundled services using the unified Dockerfile
target "ncc-services" {
  name = item.name
  matrix = {
    item = [
      { name = "rebalancer", dir = "rebalancer", package = "@hyperlane-xyz/rebalancer", image = "hyperlane-rebalancer", port = "" },
      { name = "warp-monitor", dir = "warp-monitor", package = "@hyperlane-xyz/warp-monitor", image = "hyperlane-warp-monitor", port = "" },
      { name = "ccip-server", dir = "ccip-server", package = "@hyperlane-xyz/ccip-server", image = "hyperlane-offchain-lookup-server", port = "3000" },
      { name = "keyfunder", dir = "keyfunder", package = "@hyperlane-xyz/keyfunder", image = "hyperlane-key-funder", port=""},
    ]
  }

  dockerfile = "typescript/Dockerfile.node-service"
  context    = "."
  platforms  = split(",", PLATFORMS)

  args = {
    FOUNDRY_VERSION = FOUNDRY_VERSION
    SERVICE_VERSION = SERVICE_VERSION
    SERVICE_DIR     = item.dir
    SERVICE_PACKAGE = item.package
    SERVICE_PORT    = item.port
  }

  tags = compact([
    "${REGISTRY}/${item.image}:${TAG}",
    TAG_SHA_DATE != "" ? "${REGISTRY}/${item.image}:${TAG_SHA_DATE}" : "",
  ])
}
