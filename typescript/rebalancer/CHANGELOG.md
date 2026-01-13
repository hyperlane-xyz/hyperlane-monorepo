# @hyperlane-xyz/rebalancer

## 0.1.0

### Minor Changes

- bc8b22f: Moved rebalancer-specific type definitions from `@hyperlane-xyz/sdk` to `@hyperlane-xyz/rebalancer`. Updated CLI and infra imports to use the new location. The rebalancer package is now self-contained and doesn't pollute the SDK with rebalancer-specific types.
- 9963e0e: feat: separate rebalancer package

  - Extract rebalancer logic from CLI into dedicated `@hyperlane-xyz/rebalancer` package
  - New package supports both manual CLI execution and continuous daemon mode for K8s deployments
  - CLI now imports from new package, maintaining backward compatibility for manual rebalancing

### Patch Changes

- Updated dependencies [c08fa32]
- Updated dependencies [68310db]
- Updated dependencies [b6b206d]
- Updated dependencies [239e1a1]
- Updated dependencies [bc8b22f]
- Updated dependencies [ed10fc1]
- Updated dependencies [0bce4e7]
  - @hyperlane-xyz/sdk@21.0.0
  - @hyperlane-xyz/provider-sdk@1.0.0
  - @hyperlane-xyz/utils@21.0.0
  - @hyperlane-xyz/core@10.1.4
