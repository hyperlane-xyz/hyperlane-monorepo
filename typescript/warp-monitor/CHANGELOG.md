# @hyperlane-xyz/warp-monitor

## 0.3.0

### Minor Changes

- b9c6844: MultiCollateral contracts and SDK/CLI terminology were renamed to CrossCollateral.

  The Solidity ABI was updated with renamed contracts, interfaces, router enrollment methods, domain/route getters, fee-quote method, events, and revert prefixes.

  The SDK token type was migrated to `crossCollateral`.

  Reader compatibility for legacy deployed contracts was not retained; readers now require the renamed CrossCollateral ABI methods.

### Patch Changes

- Updated dependencies [b9c6844]
- Updated dependencies [5a5d172]
- Updated dependencies [a4a74d8]
  - @hyperlane-xyz/sdk@28.0.0
  - @hyperlane-xyz/core@11.0.3
  - @hyperlane-xyz/metrics@0.2.3
  - @hyperlane-xyz/utils@28.0.0

## 0.2.2

### Patch Changes

- Updated dependencies [de5f6b5]
- Updated dependencies [a1f9e41]
- Updated dependencies [b892e61]
- Updated dependencies [7af7728]
  - @hyperlane-xyz/sdk@27.1.0
  - @hyperlane-xyz/utils@27.1.0
  - @hyperlane-xyz/metrics@0.2.2
  - @hyperlane-xyz/core@11.0.2

## 0.2.1

### Patch Changes

- Updated dependencies [f2620a1]
- Updated dependencies [f7ebf6c]
- Updated dependencies [8a6f742]
- Updated dependencies [b05e242]
- Updated dependencies [aee625c]
  - @hyperlane-xyz/sdk@27.0.0
  - @hyperlane-xyz/core@11.0.2
  - @hyperlane-xyz/metrics@0.2.1
  - @hyperlane-xyz/utils@27.0.0

## 0.2.0

### Minor Changes

- 43255a9: CrossCollateralRouter warp route support was added across the SDK, CLI, and warp monitor.

  SDK: WarpCore gained `transferRemoteTo` flows for crossCollateral tokens, including fee quoting, ERC-20 approval, and destination token resolution. EvmWarpModule now handles CrossCollateral router enrollment/unenrollment with canonical router ID normalization. EvmWarpRouteReader derives crossCollateral token config including on-chain scale. A new `EvmCrossCollateralAdapter` provides quote, approve, and transfer operations.

  CLI: `warp deploy` and `warp extend` support crossCollateral token types. A new `warp combine` command merges independent warp route configs into a single crossCollateral route. `warp send` and `warp check` work with crossCollateral routes.

  Warp monitor: Pending-transfer and inventory metrics were added for crossCollateral routes, with projected deficit scoped to collateralized routes only.

### Patch Changes

- Updated dependencies [43255a9]
- Updated dependencies [06aacac]
- Updated dependencies [763a264]
- Updated dependencies [1d116d8]
  - @hyperlane-xyz/sdk@26.0.0
  - @hyperlane-xyz/utils@26.0.0
  - @hyperlane-xyz/metrics@0.2.0
  - @hyperlane-xyz/core@11.0.1

## 0.1.6

### Patch Changes

- Updated dependencies [c2304d3]
- Updated dependencies [cd1c28a]
- Updated dependencies [69b48fa]
- Updated dependencies [048df98]
- Updated dependencies [840fb33]
  - @hyperlane-xyz/sdk@25.5.0
  - @hyperlane-xyz/metrics@0.1.11
  - @hyperlane-xyz/utils@25.5.0
  - @hyperlane-xyz/core@11.0.1

## 0.1.5

### Patch Changes

- Updated dependencies [5a7efbb]
  - @hyperlane-xyz/sdk@25.4.1
  - @hyperlane-xyz/metrics@0.1.10
  - @hyperlane-xyz/utils@25.4.1
  - @hyperlane-xyz/core@11.0.1

## 0.1.4

### Patch Changes

- Updated dependencies [1f021bf]
- Updated dependencies [d4a5026]
- Updated dependencies [934d857]
- Updated dependencies [1f3a0e6]
- Updated dependencies [027eeac]
- Updated dependencies [942bbfb]
- Updated dependencies [a3f7fd3]
- Updated dependencies [2a6bd61]
  - @hyperlane-xyz/utils@25.4.0
  - @hyperlane-xyz/sdk@25.4.0
  - @hyperlane-xyz/core@11.0.1
  - @hyperlane-xyz/metrics@0.1.9

## 0.1.3

### Patch Changes

- Updated dependencies [521d42b]
  - @hyperlane-xyz/core@10.2.0
  - @hyperlane-xyz/metrics@0.1.8
  - @hyperlane-xyz/sdk@25.3.2
  - @hyperlane-xyz/utils@25.3.2

## 0.1.2

### Patch Changes

- @hyperlane-xyz/sdk@25.3.1
- @hyperlane-xyz/metrics@0.1.7
- @hyperlane-xyz/utils@25.3.1
- @hyperlane-xyz/core@10.1.5

## 0.1.1

### Patch Changes

- Updated dependencies [aea767c]
  - @hyperlane-xyz/sdk@25.3.0
  - @hyperlane-xyz/metrics@0.1.6
  - @hyperlane-xyz/utils@25.3.0
  - @hyperlane-xyz/core@10.1.5

## 0.1.0

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

## 0.0.7

### Patch Changes

- Updated dependencies [b930534]
- Updated dependencies [a18d0e6]
  - @hyperlane-xyz/sdk@25.1.0
  - @hyperlane-xyz/utils@25.1.0
  - @hyperlane-xyz/metrics@0.1.4
  - @hyperlane-xyz/core@10.1.5

## 0.0.6

### Patch Changes

- Updated dependencies [52ce778]
- Updated dependencies [aaabbad]
  - @hyperlane-xyz/utils@25.0.0
  - @hyperlane-xyz/sdk@25.0.0
  - @hyperlane-xyz/core@10.1.5
  - @hyperlane-xyz/metrics@0.1.3

## 0.0.5

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

## 0.0.4

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

## 0.0.3

### Patch Changes

- b892d63: Migrated to use shared utilities from `@hyperlane-xyz/metrics` package, eliminating duplicate metric server implementations and ensuring consistent Prometheus metric collection across all services.
- 223fd7f: Suppressed harmless startup warnings via pnpm patches instead of runtime suppression. The bigint-buffer native bindings warning and node-fetch .data deprecation warning are now patched at the source, avoiding the need for --no-warnings flags or console.warn overrides.
- Updated dependencies [c6a6d5f]
- Updated dependencies [4c58992]
- Updated dependencies [99948bc]
- Updated dependencies [99948bc]
- Updated dependencies [b0e9d48]
- Updated dependencies [66ef635]
- Updated dependencies [7f31d77]
- Updated dependencies [7a0a9e4]
- Updated dependencies [3aec1c4]
- Updated dependencies [b892d63]
  - @hyperlane-xyz/sdk@22.0.0
  - @hyperlane-xyz/utils@22.0.0
  - @hyperlane-xyz/metrics@0.1.0
  - @hyperlane-xyz/core@10.1.5

## 0.0.2

### Patch Changes

- @hyperlane-xyz/sdk@21.1.0
- @hyperlane-xyz/utils@21.1.0
- @hyperlane-xyz/core@10.1.5

## 0.0.1

### Patch Changes

- Updated dependencies [c08fa32]
- Updated dependencies [68310db]
- Updated dependencies [b6b206d]
- Updated dependencies [bc8b22f]
- Updated dependencies [ed10fc1]
- Updated dependencies [0bce4e7]
  - @hyperlane-xyz/sdk@21.0.0
  - @hyperlane-xyz/utils@21.0.0
  - @hyperlane-xyz/core@10.1.4
