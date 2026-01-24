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
  targets = ["typescript-services"]
}

# Matrix build for all TypeScript service images
target "typescript-services" {
  name = item.name
  matrix = {
    item = [
      { name = "rebalancer", dockerfile = "typescript/rebalancer/Dockerfile", image = "hyperlane-rebalancer" },
      { name = "warp-monitor", dockerfile = "typescript/warp-monitor/Dockerfile", image = "hyperlane-warp-monitor" },
      { name = "ccip-server", dockerfile = "typescript/ccip-server/Dockerfile", image = "hyperlane-offchain-lookup-server" },
    ]
  }

  dockerfile = item.dockerfile
  context    = "."
  platforms  = split(",", PLATFORMS)

  args = {
    FOUNDRY_VERSION = FOUNDRY_VERSION
    SERVICE_VERSION = SERVICE_VERSION
  }

  tags = compact([
    "${REGISTRY}/${item.image}:${TAG}",
    TAG_SHA_DATE != "" ? "${REGISTRY}/${item.image}:${TAG_SHA_DATE}" : "",
  ])
}
