# @hyperlane-xyz/infra

Various scripts and utilities for managing and deploying Hyperlane infrastructure.

## Tips

- To enable more verbose logging, see the log env vars mentioned in the [root readme](../../README.md)
- To configure the local registry path, set the `REGISTRY_URI` env var.
- If `REGISTRY_URI` is unset, infra resolves registry data by:
  1. local `hyperlane-registry` clone (if present), then
  2. packaged `@hyperlane-xyz/registry` data from `node_modules`.
- Infra now fails fast with a clear error when `REGISTRY_URI` points to a missing path.
