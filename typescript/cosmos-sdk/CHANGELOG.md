# @hyperlane-xyz/cosmos-sdk

## 19.13.0

### Patch Changes

- @hyperlane-xyz/cosmos-types@19.13.0
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

### Patch Changes

- Updated dependencies [38a1165c8]
- Updated dependencies [08cf7eca9]
- Updated dependencies [af2cd1729]
- Updated dependencies [e37100e2e]
  - @hyperlane-xyz/provider-sdk@0.4.0
  - @hyperlane-xyz/utils@19.12.0
  - @hyperlane-xyz/cosmos-types@19.12.0

## 19.11.0

### Patch Changes

- Updated dependencies [dd6260eea]
  - @hyperlane-xyz/provider-sdk@0.3.0
  - @hyperlane-xyz/cosmos-types@19.11.0
  - @hyperlane-xyz/utils@19.11.0

## 19.10.0

### Minor Changes

- c2a64e8c5: feat: add setTokenHook to altvm interface
- a97a9939c: Fix core deployment on cosmos chains failing as the ism was not set properly on mailbox creation
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
  - @hyperlane-xyz/cosmos-types@19.10.0

## 19.9.0

### Patch Changes

- Updated dependencies [8c027d852]
  - @hyperlane-xyz/utils@19.9.0
  - @hyperlane-xyz/cosmos-types@19.9.0

## 19.8.0

### Minor Changes

- 78ff6cd47: add new methods for altvm interface

### Patch Changes

- Updated dependencies [2ed21c97d]
- Updated dependencies [78ff6cd47]
- Updated dependencies [3f75ad86d]
  - @hyperlane-xyz/utils@19.8.0
  - @hyperlane-xyz/cosmos-types@19.8.0

## 19.7.0

### Patch Changes

- @hyperlane-xyz/cosmos-types@19.7.0
- @hyperlane-xyz/utils@19.7.0

## 19.6.0

### Patch Changes

- Updated dependencies [419e16910]
  - @hyperlane-xyz/utils@19.6.0
  - @hyperlane-xyz/cosmos-types@19.6.0

## 19.6.0-beta.0

### Patch Changes

- Updated dependencies [419e16910]
  - @hyperlane-xyz/utils@19.6.0-beta.0
  - @hyperlane-xyz/cosmos-types@19.6.0-beta.0

## 19.5.0

### Patch Changes

- Updated dependencies [312826d10]
  - @hyperlane-xyz/utils@19.5.0
  - @hyperlane-xyz/cosmos-types@19.5.0

## 19.4.0

### Patch Changes

- Updated dependencies [5a4e22d34]
  - @hyperlane-xyz/utils@19.4.0
  - @hyperlane-xyz/cosmos-types@19.4.0

## 19.3.0

### Patch Changes

- @hyperlane-xyz/cosmos-types@19.3.0
- @hyperlane-xyz/utils@19.3.0

## 19.2.0

### Patch Changes

- @hyperlane-xyz/cosmos-types@19.2.0
- @hyperlane-xyz/utils@19.2.0

## 19.1.1

### Patch Changes

- @hyperlane-xyz/cosmos-types@19.1.1
- @hyperlane-xyz/utils@19.1.1

## 19.1.0

### Patch Changes

- @hyperlane-xyz/cosmos-types@19.1.0
- @hyperlane-xyz/utils@19.1.0

## 19.0.0

### Major Changes

- 32479e139: feat: implement cosmos-sdk for new AltVM interface

### Minor Changes

- 8eab305bd: chore: add transactionToPrintableJson to altvm interface
- e42a0e8e1: chore: updated AltVM interface

### Patch Changes

- Updated dependencies [8eab305bd]
- Updated dependencies [e42a0e8e1]
- Updated dependencies [32479e139]
  - @hyperlane-xyz/utils@19.0.0
  - @hyperlane-xyz/cosmos-types@19.0.0

## 18.3.0

### Patch Changes

- @hyperlane-xyz/cosmos-types@18.3.0

## 18.2.0

### Minor Changes

- dfa9d368c: Added a `getCometClientOrFail` to the `HyperlaneModuleClient` to expose the internal provider connection

### Patch Changes

- @hyperlane-xyz/cosmos-types@18.2.0

## 18.1.0

### Patch Changes

- @hyperlane-xyz/cosmos-types@18.1.0

## 18.0.0

### Patch Changes

- @hyperlane-xyz/cosmos-types@18.0.0

## 17.0.0

### Patch Changes

- @hyperlane-xyz/cosmos-types@17.0.0

## 16.2.0

### Patch Changes

- @hyperlane-xyz/cosmos-types@16.2.0

## 16.1.1

### Patch Changes

- @hyperlane-xyz/cosmos-types@16.1.1

## 16.1.0

### Patch Changes

- @hyperlane-xyz/cosmos-types@16.1.0

## 16.0.0

### Patch Changes

- @hyperlane-xyz/cosmos-types@16.0.0

## 15.0.0

### Patch Changes

- @hyperlane-xyz/cosmos-types@15.0.0

## 14.4.0

### Patch Changes

- @hyperlane-xyz/cosmos-types@14.4.0

## 14.3.0

### Patch Changes

- @hyperlane-xyz/cosmos-types@14.3.0

## 14.2.0

### Patch Changes

- @hyperlane-xyz/cosmos-types@14.2.0

## 14.1.0

### Patch Changes

- @hyperlane-xyz/cosmos-types@14.1.0

## 14.0.0

### Patch Changes

- @hyperlane-xyz/cosmos-types@14.0.0

## 13.4.0

### Minor Changes

- 19384e74b: sdk support for cosmos hyperlane module v1.0.1

### Patch Changes

- Updated dependencies [19384e74b]
  - @hyperlane-xyz/cosmos-types@13.4.0

## 13.3.0

### Patch Changes

- @hyperlane-xyz/cosmos-types@13.3.0

## 13.2.1

### Patch Changes

- @hyperlane-xyz/cosmos-types@13.2.1

## 13.2.0

### Patch Changes

- @hyperlane-xyz/cosmos-types@13.2.0

## 13.1.1

### Patch Changes

- ba4deea: Revert workspace dependency syntax.
- Updated dependencies [ba4deea]
  - @hyperlane-xyz/cosmos-types@13.1.1

## 13.1.0

### Patch Changes

- @hyperlane-xyz/cosmos-types@13.1.0

## 13.0.0

### Minor Changes

- 2724559: add cosmos native routing ism cosmos-sdk and types

### Patch Changes

- Updated dependencies [2724559]
  - @hyperlane-xyz/cosmos-types@13.0.0

## 12.6.0

### Minor Changes

- 76f0eba: Add Cosmos Native ISM Reader & Module

### Patch Changes

- @hyperlane-xyz/cosmos-types@12.6.0

## 12.5.0

### Patch Changes

- @hyperlane-xyz/cosmos-types@12.5.0

## 12.4.0

### Patch Changes

- @hyperlane-xyz/cosmos-types@12.4.0

## 12.3.0

### Patch Changes

- @hyperlane-xyz/cosmos-types@12.3.0

## 12.2.0

### Patch Changes

- @hyperlane-xyz/cosmos-types@12.2.0
