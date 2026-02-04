# @hyperlane-xyz/relayer

## 0.1.0

### Minor Changes

- 42b72c3: Extracted relayer into dedicated `@hyperlane-xyz/relayer` package

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

### Patch Changes

- Updated dependencies [d1d90d2]
- Updated dependencies [52fd0f8]
- Updated dependencies [7c22cff]
- Updated dependencies [52fd0f8]
- Updated dependencies [52fd0f8]
- Updated dependencies [a10cfc8]
- Updated dependencies [6ddef74]
- Updated dependencies [80f3635]
- Updated dependencies [576cd95]
- Updated dependencies [9aa93f4]
- Updated dependencies [42b72c3]
- Updated dependencies [a5d6cae]
  - @hyperlane-xyz/sdk@23.0.0
  - @hyperlane-xyz/utils@23.0.0
  - @hyperlane-xyz/metrics@0.1.1
  - @hyperlane-xyz/core@10.1.5
