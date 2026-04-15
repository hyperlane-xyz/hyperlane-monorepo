# @hyperlane-xyz/tron-sdk

## 22.1.14

### Patch Changes

- @hyperlane-xyz/utils@31.2.1
- @hyperlane-xyz/core@11.3.1
- @hyperlane-xyz/provider-sdk@4.3.4

## 22.1.13

### Patch Changes

- @hyperlane-xyz/utils@31.2.0
- @hyperlane-xyz/core@11.3.1
- @hyperlane-xyz/provider-sdk@4.3.3

## 22.1.12

### Patch Changes

- 8a082af: Added runtime entrypoints for non-EVM SDKs and avoided bundling heavy deploy-time modules in UI wallet integrations.
  - @hyperlane-xyz/utils@31.1.0
  - @hyperlane-xyz/core@11.3.1
  - @hyperlane-xyz/provider-sdk@4.3.2

## 22.1.11

### Patch Changes

- Updated dependencies [d5168fc]
  - @hyperlane-xyz/utils@31.0.1
  - @hyperlane-xyz/core@11.3.1
  - @hyperlane-xyz/provider-sdk@4.3.1

## 22.1.10

### Patch Changes

- 1dac3b0: TronJsonRpcProvider and TronTransactionBuilder were updated to parse custom_rpc_header query params into HTTP headers, fixing auth with third-party RPC providers like Tatum.
- Updated dependencies [44626fb]
- Updated dependencies [7ad1f9e]
  - @hyperlane-xyz/provider-sdk@4.3.0
  - @hyperlane-xyz/core@11.3.1
  - @hyperlane-xyz/utils@31.0.0

## 22.1.9

### Patch Changes

- @hyperlane-xyz/utils@30.1.1
- @hyperlane-xyz/core@11.3.0
- @hyperlane-xyz/provider-sdk@4.2.5

## 22.1.8

### Patch Changes

- Updated dependencies [9ac480a]
- Updated dependencies [9eefa2d]
- Updated dependencies [4c4462f]
- Updated dependencies [696da11]
- Updated dependencies [46dda6c]
- Updated dependencies [ac1acbb]
- Updated dependencies [d38fad1]
- Updated dependencies [cfed1d2]
- Updated dependencies [9061916]
- Updated dependencies [d41d088]
- Updated dependencies [b691b87]
- Updated dependencies [7018cc6]
- Updated dependencies [ef4399b]
- Updated dependencies [3fef31c]
- Updated dependencies [d98726f]
- Updated dependencies [40356c6]
- Updated dependencies [6f8c503]
- Updated dependencies [f2749a6]
- Updated dependencies [6bd4fd1]
- Updated dependencies [57e46b1]
- Updated dependencies [993de2b]
- Updated dependencies [b5f897c]
- Updated dependencies [9515191]
  - @hyperlane-xyz/core@11.3.0
  - @hyperlane-xyz/utils@30.1.0
  - @hyperlane-xyz/provider-sdk@4.2.4

## 22.1.7

### Patch Changes

- Updated dependencies [ac297da]
- Updated dependencies [77db719]
- Updated dependencies [37255ba]
- Updated dependencies [7646819]
  - @hyperlane-xyz/core@11.2.0
  - @hyperlane-xyz/provider-sdk@4.2.3
  - @hyperlane-xyz/utils@30.0.0

## 22.1.6

### Patch Changes

- @hyperlane-xyz/utils@29.1.0
- @hyperlane-xyz/core@11.1.0
- @hyperlane-xyz/provider-sdk@4.2.2

## 22.1.5

### Patch Changes

- @hyperlane-xyz/utils@29.0.1
- @hyperlane-xyz/core@11.1.0
- @hyperlane-xyz/provider-sdk@4.2.1

## 22.1.4

### Patch Changes

- 3c6b1ad: Fixed Tron gas estimation and transaction building for wallet integration.
- 084c6b6: The TypeScript packages were updated to support TypeScript 6.0 and to make ambient type loading explicit so the future TypeScript 7.0 upgrade is smoother.
- Updated dependencies [3c6b1ad]
- Updated dependencies [084c6b6]
  - @hyperlane-xyz/utils@29.0.0
  - @hyperlane-xyz/provider-sdk@4.2.0
  - @hyperlane-xyz/core@11.1.0

## 22.1.3

### Patch Changes

- 2e622e8: TronJsonRpcProvider was changed to extend `StaticJsonRpcProvider` with a `detectNetwork` fallback and default `estimateGas` override for Tron's unreliable RPC methods. Automatic `/jsonrpc` suffix appending was removed — callers now pass the correct URL directly. TronWallet now parses `custom_rpc_header` query params from RPC URLs and forwards them as headers to TronWeb HTTP API calls (needed for TronGrid API key auth). `alterTransaction` was switched to `txLocal: true` to avoid unnecessary network roundtrips.
- Updated dependencies [5caac66]
- Updated dependencies [6c715a7]
  - @hyperlane-xyz/provider-sdk@4.1.0
  - @hyperlane-xyz/core@11.1.0
  - @hyperlane-xyz/utils@28.1.0

## 22.1.2

### Patch Changes

- Updated dependencies [83767b9]
- Updated dependencies [a6b7bf3]
- Updated dependencies [a4a74d8]
  - @hyperlane-xyz/provider-sdk@4.0.0
  - @hyperlane-xyz/core@11.0.3
  - @hyperlane-xyz/utils@28.0.0

## 22.1.1

### Patch Changes

- Updated dependencies [b892e61]
- Updated dependencies [b892e61]
- Updated dependencies [b892e61]
  - @hyperlane-xyz/provider-sdk@3.1.0
  - @hyperlane-xyz/utils@27.1.0
  - @hyperlane-xyz/core@11.0.2

## 22.1.0

### Minor Changes

- 4a816e3: Add retry logic to TronJsonProvider

### Patch Changes

- Updated dependencies [f7ebf6c]
  - @hyperlane-xyz/core@11.0.2
  - @hyperlane-xyz/utils@27.0.0
  - @hyperlane-xyz/provider-sdk@3.0.1

## 22.0.0

### Major Changes

- 1d116d8: Added Tron ProtocolType & deprecated Tron TechnicalStack. Add support for TronLink wallet in the widgets.

### Patch Changes

- Updated dependencies [06aacac]
- Updated dependencies [1d116d8]
  - @hyperlane-xyz/utils@26.0.0
  - @hyperlane-xyz/provider-sdk@3.0.0
  - @hyperlane-xyz/core@11.0.1

## 21.1.5

### Patch Changes

- Updated dependencies [e197331]
- Updated dependencies [840fb33]
  - @hyperlane-xyz/provider-sdk@2.0.0
  - @hyperlane-xyz/utils@25.5.0
  - @hyperlane-xyz/core@11.0.1

## 21.1.4

### Patch Changes

- @hyperlane-xyz/utils@25.4.1
- @hyperlane-xyz/provider-sdk@1.4.1
- @hyperlane-xyz/core@11.0.1

## 21.1.3

### Patch Changes

- Updated dependencies [1f021bf]
- Updated dependencies [027eeac]
- Updated dependencies [1f021bf]
  - @hyperlane-xyz/utils@25.4.0
  - @hyperlane-xyz/core@11.0.1
  - @hyperlane-xyz/provider-sdk@1.4.0

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
