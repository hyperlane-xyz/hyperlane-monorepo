# Bake configuration for the unified Hyperlane TypeScript node services Docker image
# https://depot.dev/docs/container-builds/how-to-guides/docker-bake
#
# This file defines a single target that builds all TypeScript services into one image.
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
  default = "ghcr.io/hyperlane-xyz"
}

# Default group builds the unified image
group "default" {
  targets = ["node-services"]
}

# Single unified image containing all NCC-bundled services
target "node-services" {
  dockerfile = "typescript/Dockerfile.node-service"
  context    = "."
  platforms  = split(",", PLATFORMS)

  args = {
    FOUNDRY_VERSION = FOUNDRY_VERSION
    SERVICE_VERSION = SERVICE_VERSION
  }

  tags = compact([
    "${REGISTRY}/hyperlane-node-services:${TAG}",
    TAG_SHA_DATE != "" ? "${REGISTRY}/hyperlane-node-services:${TAG_SHA_DATE}" : "",
  ])
}
