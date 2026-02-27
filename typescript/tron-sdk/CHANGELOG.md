# @hyperlane-xyz/tron-sdk

## 21.1.2

### Patch Changes

- Updated dependencies [521d42b]
  - @hyperlane-xyz/core@10.2.0
  - @hyperlane-xyz/utils@25.3.2
  - @hyperlane-xyz/provider-sdk@1.3.6

## 21.1.1

### Patch Changes

- 7636bb4: fix: assert import
  - @hyperlane-xyz/utils@25.3.1
  - @hyperlane-xyz/provider-sdk@1.3.5
  - @hyperlane-xyz/core@10.1.5

## 21.1.0

### Minor Changes

- aea767c: Tron Virtual Machine (TVM) support added to the Hyperlane SDK. The new `@hyperlane-xyz/tron-sdk` package provides `TronJsonRpcProvider`, `TronWallet`, and `TronContractFactory` for interacting with Tron chains. The SDK deployers now automatically use Tron-compiled factories for Create2-affected contracts (ISM/hook factories, ICA router) when deploying to Tron chains.

### Patch Changes

- @hyperlane-xyz/utils@25.3.0
- @hyperlane-xyz/provider-sdk@1.3.4

## 21.0.2

### Patch Changes

- Updated dependencies [360db52]
- Updated dependencies [ccd638d]
  - @hyperlane-xyz/utils@25.2.0
  - @hyperlane-xyz/provider-sdk@1.3.3
  - @hyperlane-xyz/eslint-config@25.2.0

## 21.0.1

### Patch Changes

- Updated dependencies [b930534]
  - @hyperlane-xyz/utils@25.1.0
  - @hyperlane-xyz/provider-sdk@1.3.2
  - @hyperlane-xyz/eslint-config@25.1.0

## 21.0.0

### Major Changes

- 1eb26db: feat: add tron-sdk base package

### Patch Changes

- Updated dependencies [52ce778]
  - @hyperlane-xyz/utils@25.0.0
  - @hyperlane-xyz/provider-sdk@1.3.1
  - @hyperlane-xyz/eslint-config@25.0.0
