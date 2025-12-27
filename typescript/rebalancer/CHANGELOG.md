# @hyperlane-xyz/rebalancer

## 0.1.0

### Minor Changes

- 9963e0e: feat: separate rebalancer package

  - Extract rebalancer logic from CLI into dedicated `@hyperlane-xyz/rebalancer` package
  - New package supports both manual CLI execution and continuous daemon mode for K8s deployments
  - CLI now imports from new package, maintaining backward compatibility for manual rebalancing

### Patch Changes

- Updated dependencies [239e1a1]
  - @hyperlane-xyz/provider-sdk@0.8.0
  - @hyperlane-xyz/sdk@20.2.0
  - @hyperlane-xyz/utils@20.2.0
  - @hyperlane-xyz/core@10.1.4
