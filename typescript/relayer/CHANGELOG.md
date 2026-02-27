# @hyperlane-xyz/relayer

## 1.1.4

### Patch Changes

- Updated dependencies [1f021bf]
- Updated dependencies [d4a5026]
- Updated dependencies [934d857]
- Updated dependencies [1f3a0e6]
- Updated dependencies [942bbfb]
- Updated dependencies [a3f7fd3]
- Updated dependencies [2a6bd61]
  - @hyperlane-xyz/utils@25.4.0
  - @hyperlane-xyz/sdk@25.4.0
  - @hyperlane-xyz/core@11.0.0
  - @hyperlane-xyz/metrics@0.1.9

## 1.1.3

### Patch Changes

- Updated dependencies [521d42b]
  - @hyperlane-xyz/core@10.2.0
  - @hyperlane-xyz/metrics@0.1.8
  - @hyperlane-xyz/sdk@25.3.2
  - @hyperlane-xyz/utils@25.3.2

## 1.1.2

### Patch Changes

- @hyperlane-xyz/sdk@25.3.1
- @hyperlane-xyz/metrics@0.1.7
- @hyperlane-xyz/utils@25.3.1
- @hyperlane-xyz/core@10.1.5

## 1.1.1

### Patch Changes

- Updated dependencies [aea767c]
  - @hyperlane-xyz/sdk@25.3.0
  - @hyperlane-xyz/metrics@0.1.6
  - @hyperlane-xyz/utils@25.3.0
  - @hyperlane-xyz/core@10.1.5

## 1.1.0

### Minor Changes

- ccd638d: Improved shared RPC override handling across TypeScript services.

### Patch Changes

- Updated dependencies [215dff0]
- Updated dependencies [d2f75a1]
- Updated dependencies [360db52]
- Updated dependencies [18ec479]
- Updated dependencies [795d93e]
- Updated dependencies [e143956]
- Updated dependencies [ccd638d]
- Updated dependencies [c61d612]
- Updated dependencies [c2affe2]
  - @hyperlane-xyz/sdk@25.2.0
  - @hyperlane-xyz/utils@25.2.0
  - @hyperlane-xyz/metrics@0.1.5
  - @hyperlane-xyz/core@10.1.5

## 1.0.2

### Patch Changes

- Updated dependencies [b930534]
- Updated dependencies [a18d0e6]
  - @hyperlane-xyz/sdk@25.1.0
  - @hyperlane-xyz/utils@25.1.0
  - @hyperlane-xyz/metrics@0.1.4
  - @hyperlane-xyz/core@10.1.5

## 1.0.1

### Patch Changes

- 52ce778: A `LazyAsync` helper was added to `@hyperlane-xyz/utils` for safe, deduplicated async initialization. It replaces the scattered pattern of `if (!cached) { cached = await init(); } return cached` with an approach that deduplicates concurrent callers, clears state on errors to allow retries, and supports reset capability. Consumer packages were migrated to use this utility.
- Updated dependencies [52ce778]
- Updated dependencies [aaabbad]
  - @hyperlane-xyz/utils@25.0.0
  - @hyperlane-xyz/sdk@25.0.0
  - @hyperlane-xyz/core@10.1.5
  - @hyperlane-xyz/metrics@0.1.3

## 1.0.0

### Major Changes

- 4de5071: **BREAKING**: `MetadataBuilder.build()` return type changed from `string` to `MetadataBuildResult`. Access `.metadata` on the result to get the encoded bytes.

  Added real-time validator signature status to MetadataBuilder. The builder returns detailed `ValidatorInfo` for each validator including signing status ('signed' | 'pending' | 'error'), checkpoint indices, and actual signatures. Aggregation and routing ISMs return nested results for sub-modules. Added helper functions: `isMetadataBuildable()`, `getSignedValidatorCount()`, `isQuorumMet()`.

### Patch Changes

- Updated dependencies [57461b2]
- Updated dependencies [d580bb6]
- Updated dependencies [50868ce]
- Updated dependencies [b05e9f8]
- Updated dependencies [f44c2b4]
- Updated dependencies [9dc71fe]
- Updated dependencies [bde05e9]
- Updated dependencies [d0b8c24]
- Updated dependencies [4de5071]
  - @hyperlane-xyz/utils@24.0.0
  - @hyperlane-xyz/sdk@24.0.0
  - @hyperlane-xyz/core@10.1.5
  - @hyperlane-xyz/metrics@0.1.2

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
