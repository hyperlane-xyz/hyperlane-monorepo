# @hyperlane-xyz/radix-sdk

## 19.13.0

### Minor Changes

- ae8ef4389: Replaced the RadixCoreTx and RadixCorePopulate with artifact specific functions

### Patch Changes

- @hyperlane-xyz/utils@19.13.0
- @hyperlane-xyz/provider-sdk@0.5.0

## 19.12.0

### Minor Changes

- 38a1165c8: - Update CLI context `altVmSigners` to be a `ChainMap` instead of `AltVMSignerFactory`,
  - Update CLI context `altVmProviders` to be a `ChainMap` instead of `AltVMSignerFactory`.
  - Update all existing getter methods to use `mustTry`, instead of `assert`.
  - Delete `AltVMSupportedProtocols` and `AltVMProviderFactory`.
  - Move functions from `AltVMSignerFactory` to top-level functions.
  - Add `getMinGas` to Aleo, Cosmos and Radix ProtocolProvider.
- 43b3756d9: Replaced the `RadixCoreQuery` class with individual functions for reading the on-chain artifacts

### Patch Changes

- Updated dependencies [38a1165c8]
- Updated dependencies [08cf7eca9]
- Updated dependencies [af2cd1729]
- Updated dependencies [e37100e2e]
  - @hyperlane-xyz/provider-sdk@0.4.0
  - @hyperlane-xyz/utils@19.12.0

## 19.11.0

### Minor Changes

- dd6260eea: Added testing utils for running a radix node locally under the `testing` sub-import path

### Patch Changes

- Updated dependencies [dd6260eea]
  - @hyperlane-xyz/provider-sdk@0.3.0
  - @hyperlane-xyz/utils@19.11.0

## 19.10.0

### Minor Changes

- c2a64e8c5: feat: add setTokenHook to altvm interface
- f604423b9: - Remove AltVMProviderFactory to new API in deploy-sdk (loadlProtocolProviders) and Registry singleton.
  - Add `chainId` and `rpcUrls` to `ChainMetadataForAltVM`. Add `CosmosNativeProtocolProvider` and `RadixProtocolProvider` to both cosmos-sdk and radix-sdk, respectively.
  - Add `forWarpRead`, `forCoreRead`, and `forCoreCheck` to signerMiddleware to enable chain resolving for these CLI functions.
  - Add `assert` after some `altVmProvider.get` calls in SDK configUtils.

### Patch Changes

- Updated dependencies [aad2988c9]
- Updated dependencies [c2a64e8c5]
- Updated dependencies [a0ba5e2fb]
- Updated dependencies [66bed7126]
- Updated dependencies [f604423b9]
  - @hyperlane-xyz/utils@19.10.0
  - @hyperlane-xyz/provider-sdk@0.2.0

## 19.9.0

### Patch Changes

- Updated dependencies [8c027d852]
  - @hyperlane-xyz/utils@19.9.0

## 19.8.0

### Minor Changes

- 78ff6cd47: add new methods for altvm interface

### Patch Changes

- Updated dependencies [2ed21c97d]
- Updated dependencies [78ff6cd47]
- Updated dependencies [3f75ad86d]
  - @hyperlane-xyz/utils@19.8.0

## 19.7.0

### Patch Changes

- @hyperlane-xyz/utils@19.7.0

## 19.6.0

### Patch Changes

- Updated dependencies [419e16910]
  - @hyperlane-xyz/utils@19.6.0

## 19.6.0-beta.0

### Patch Changes

- Updated dependencies [419e16910]
  - @hyperlane-xyz/utils@19.6.0-beta.0

## 19.5.0

### Minor Changes

- 312826d10: - Add the RadixBase.createPublishPackageManifest method to build a compiled package publishing transaction.
  - Add the RadixSigner.publishPackage method to publish packages on a radix network

### Patch Changes

- Updated dependencies [312826d10]
  - @hyperlane-xyz/utils@19.5.0

## 19.4.0

### Patch Changes

- Updated dependencies [5a4e22d34]
  - @hyperlane-xyz/utils@19.4.0

## 19.3.0

### Patch Changes

- @hyperlane-xyz/utils@19.3.0

## 19.2.0

### Patch Changes

- @hyperlane-xyz/utils@19.2.0

## 19.1.1

### Patch Changes

- @hyperlane-xyz/utils@19.1.1

## 19.1.0

### Patch Changes

- @hyperlane-xyz/utils@19.1.0

## 19.0.0

### Major Changes

- e42a0e8e1: feat: radix support for the cli

### Minor Changes

- 8eab305bd: chore: add transactionToPrintableJson to altvm interface

### Patch Changes

- Updated dependencies [8eab305bd]
- Updated dependencies [e42a0e8e1]
- Updated dependencies [32479e139]
  - @hyperlane-xyz/utils@19.0.0

## 18.3.0

### Minor Changes

- e5a530e43: Update radix package address
- b66129ee2: export radix hook reader

### Patch Changes

- Updated dependencies [c41bc3b93]
- Updated dependencies [2c47e1143]
- Updated dependencies [6b8419370]
  - @hyperlane-xyz/utils@18.3.0

## 18.2.0

### Patch Changes

- @hyperlane-xyz/utils@18.2.0

## 18.1.0

### Patch Changes

- 73be9b8d2: Don't use radix-engine-toolkit for frontend application usage.
  - @hyperlane-xyz/utils@18.1.0

## 18.0.0

### Patch Changes

- Updated dependencies [cfc0eb2a7]
  - @hyperlane-xyz/utils@18.0.0
