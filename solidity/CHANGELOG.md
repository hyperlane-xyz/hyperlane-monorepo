# @hyperlane-xyz/core

## 5.1.0

### Minor Changes

- e151b5f9a: Added SDK support for ArbL2ToL1Hook/ISM for selfrelay

### Patch Changes

- 2edfa4043: fix: only evaluate dynamic revert reasons in reverting branch
  - @hyperlane-xyz/utils@5.1.0

## 5.0.0

### Patch Changes

- 90598ad44: Removed outbox as param for ArbL2ToL1Ism
- Updated dependencies [388d25517]
- Updated dependencies [488f949ef]
- Updated dependencies [dfa908796]
- Updated dependencies [1474865ae]
  - @hyperlane-xyz/utils@5.0.0

## 4.1.0

### Patch Changes

- @hyperlane-xyz/utils@4.1.0

## 4.0.0

### Minor Changes

- 44cc9bf6b: Add CLI command to support AVS validator status check

### Patch Changes

- @hyperlane-xyz/utils@4.0.0

## 3.16.0

### Patch Changes

- @hyperlane-xyz/utils@3.16.0

## 3.15.1

### Patch Changes

- 6620fe636: fix: `TokenRouter.transferRemote` with hook overrides
  - @hyperlane-xyz/utils@3.15.1

## 3.15.0

### Minor Changes

- 51bfff683: Mint/burn limit checking for xERC20 bridging
  Corrects CLI output for HypXERC20 and HypXERC20Lockbox deployments

### Patch Changes

- @hyperlane-xyz/utils@3.15.0

## 3.14.0

### Patch Changes

- a8a68f6f6: fix: make XERC20 and XERC20 Lockbox proxy-able
  - @hyperlane-xyz/utils@3.14.0

## 3.13.0

### Minor Changes

- babe816f8: Support xERC20 and xERC20 Lockbox in SDK and CLI
- b440d98be: Added support for registering/deregistering from the Hyperlane AVS

### Patch Changes

- Updated dependencies [0cf692e73]
  - @hyperlane-xyz/utils@3.13.0

## 3.12.0

### Patch Changes

- Updated dependencies [69de68a66]
  - @hyperlane-xyz/utils@3.12.0

## 3.11.1

### Patch Changes

- @hyperlane-xyz/utils@3.11.1

## 3.11.0

### Minor Changes

- b6fdf2f7f: Implement XERC20 and FiatToken collateral warp routes
- b63714ede: Convert all public hyperlane npm packages from CJS to pure ESM

### Patch Changes

- Updated dependencies [b63714ede]
- Updated dependencies [2b3f75836]
- Updated dependencies [af2634207]
  - @hyperlane-xyz/utils@3.11.0

## 3.10.0

### Minor Changes

- 96485144a: SDK support for ICA deployment and operation.
- 38358ecec: Deprecate Polygon Mumbai testnet (soon to be replaced by Polygon Amoy testnet)

### Patch Changes

- Updated dependencies [96485144a]
- Updated dependencies [4e7a43be6]
  - @hyperlane-xyz/utils@3.10.0

## 3.9.0

### Patch Changes

- @hyperlane-xyz/utils@3.9.0

## 3.8.2

### Patch Changes

- @hyperlane-xyz/utils@3.8.2

## 3.8.1

### Patch Changes

- Updated dependencies [5daaae274]
  - @hyperlane-xyz/utils@3.8.1

## 3.8.0

### Minor Changes

- 9681df08d: Remove support for goerli networks (including optimismgoerli, arbitrumgoerli, lineagoerli and polygonzkevmtestnet)
- 9681df08d: Enabled verification of contracts as part of the deployment flow.

  - Solidity build artifact is now included as part of the `@hyperlane-xyz/core` package.
  - Updated the `HyperlaneDeployer` to perform contract verification immediately after deploying a contract. A default verifier is instantiated using the core build artifact.
  - Updated the `HyperlaneIsmFactory` to re-use the `HyperlaneDeployer` for deployment where possible.
  - Minor logging improvements throughout deployers.

### Patch Changes

- Updated dependencies [9681df08d]
  - @hyperlane-xyz/utils@3.8.0

## 3.7.0

### Patch Changes

- @hyperlane-xyz/utils@3.7.0

## 3.6.2

### Patch Changes

- @hyperlane-xyz/utils@3.6.2

## 3.6.1

### Patch Changes

- e4e4f93fc: Support pausable ISM in deployer and checker
- Updated dependencies [3c298d064]
- Updated dependencies [df24eec8b]
- Updated dependencies [78e50e7da]
  - @hyperlane-xyz/utils@3.6.1

## 3.6.0

### Patch Changes

- @hyperlane-xyz/utils@3.6.0

## 3.5.1

### Patch Changes

- @hyperlane-xyz/utils@3.5.1

## 3.5.0

### Patch Changes

- @hyperlane-xyz/utils@3.5.0

## 3.4.0

### Patch Changes

- e06fe0b32: Supporting DefaultFallbackRoutingIsm through non-factory deployments
- Updated dependencies [fd4fc1898]
  - @hyperlane-xyz/utils@3.4.0

## 3.3.0

### Patch Changes

- 350175581: Rename StaticProtocolFee hook to ProtocolFee for clarity
  - @hyperlane-xyz/utils@3.3.0

## 3.2.0

### Minor Changes

- df34198d4: Includes storage gap in Mailbox Client for forwards compatibility

### Patch Changes

- @hyperlane-xyz/utils@3.2.0

## 3.1.10

### Patch Changes

- c9e0aedae: Improve client side StandardHookMetadata library interface
  - @hyperlane-xyz/utils@3.1.10
