---
"@hyperlane-xyz/relayer": minor
"@hyperlane-xyz/cli": minor
"@hyperlane-xyz/sdk": minor
"@hyperlane-xyz/infra": patch
---

Extracted relayer into dedicated `@hyperlane-xyz/relayer` package

- Moved `HyperlaneRelayer` class from SDK to new package
- Moved ISM metadata builders from SDK to relayer package
- New package supports both manual CLI execution and continuous daemon mode for K8s deployments
- Added Prometheus metrics support with `/metrics` endpoint (enabled by default on port 9090)
- CLI and infra now import from new package
- **Breaking**: The following exports were removed from `@hyperlane-xyz/sdk` and are now available from `@hyperlane-xyz/relayer`:
  - `HyperlaneRelayer`, `RelayerCacheSchema`, `messageMatchesWhitelist`
  - `BaseMetadataBuilder`, `decodeIsmMetadata`
  - All metadata builder classes (`AggregationMetadataBuilder`, `MultisigMetadataBuilder`, etc.)
- `offchainLookupRequestMessageHash` remains exported from SDK for ccip-server compatibility
- Added `randomDeployableIsmConfig` test utility to SDK for generating deployable ISM configs with custom validators
