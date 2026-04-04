---
'@hyperlane-xyz/cli': minor
---

Added CLI support for Predicate attestations in warp send command.

CLI Changes:
- Added `--predicate-api-key` option to `warp send` for automatic attestation fetching from Predicate API
- Added `--attestation` option to `warp send` for using pre-obtained attestations (JSON string)
- Added validation to prevent Predicate usage with native token warp routes (only ERC20 supported)
- Detect PredicateRouterWrapper address and send to Predicate API for correct attestation target
- Added E2E tests for warp send with Predicate attestations
- Added example YAML configs for Predicate warp routes
