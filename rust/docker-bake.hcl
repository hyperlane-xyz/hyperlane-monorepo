# Bake configuration for Hyperlane agent Docker images
# https://depot.dev/docs/container-builds/how-to-guides/docker-bake
#
# This file defines all agent image targets for parallel builds with shared caching.
# Usage: depot bake --file rust/docker-bake.hcl
#
# Variables can be overridden via environment or --set:
#   TAG=main depot bake --file rust/docker-bake.hcl
#   depot bake --set TAG=main --file rust/docker-bake.hcl

# Variables passed from CI (override via environment or --set)
variable "TAG" {
  default = "latest"
}

variable "TAG_SHA_DATE" {
  default = ""
}

variable "SEMVER" {
  default = ""
}

variable "SEMVER_MINOR" {
  default = ""
}

variable "PLATFORMS" {
  default = "linux/amd64"
}

# Registry prefix for all images
variable "REGISTRY" {
  default = "gcr.io/abacus-labs-dev"
}

# Default group builds all targets
group "default" {
  targets = ["agent-images"]
}

# Matrix build for all agent images
# Each item produces a separate image with the same tags
target "agent-images" {
  name = item.name
  matrix = {
    item = [
      { name = "validator", target = "validator", image = "hyperlane-agent-validator" },
      { name = "relayer",   target = "relayer",   image = "hyperlane-agent-relayer" },
      { name = "scraper",   target = "scraper",   image = "hyperlane-agent-scraper" },
      { name = "agent",     target = "agent",     image = "hyperlane-agent" },
    ]
  }

  dockerfile = "rust/Dockerfile"
  context    = "."
  target     = item.target
  platforms  = split(",", PLATFORMS)

  tags = compact([
    "${REGISTRY}/${item.image}:${TAG}",
    TAG_SHA_DATE != "" ? "${REGISTRY}/${item.image}:${TAG_SHA_DATE}" : "",
    SEMVER != "" ? "${REGISTRY}/${item.image}:${SEMVER}" : "",
    SEMVER_MINOR != "" ? "${REGISTRY}/${item.image}:${SEMVER_MINOR}" : "",
  ])
}
