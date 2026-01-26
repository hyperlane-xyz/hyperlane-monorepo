# @hyperlane-xyz/warp-monitor

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
