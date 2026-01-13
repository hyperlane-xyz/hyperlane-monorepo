# @hyperlane-xyz/provider-sdk

## 1.0.0

### Minor Changes

- 239e1a1: Migrate AltVm JsonSubmittor and FileSubmittor to deploy-sdk (from provider-sdk and cli, respectively)
- ed10fc1: Introduced the Artifact API for ISM operations on AltVMs. The new API provides a unified interface for reading and writing ISM configurations across different blockchain protocols. Radix ISM readers and writers fully implemented; Cosmos ISM readers implemented. The generic `IsmReader` in deploy-sdk replaces the legacy `AltVMIsmReader` and supports recursive expansion of routing ISM configurations.

### Patch Changes

- Updated dependencies [0bce4e7]
  - @hyperlane-xyz/utils@21.0.0

## 0.7.0

### Minor Changes

- 11fa887: Upgrade TypeScript from 5.3.3 to 5.8.3 and compilation target to ES2023

  - Upgraded TypeScript from 5.3.3 to 5.8.3 across all packages
  - Updated compilation target from ES2022 to ES2023 (Node 16+ fully supported)
  - Converted internal const enums to 'as const' pattern for better compatibility
  - Updated @types/node from ^18.14.5 to ^20.17.0 for TypeScript 5.7+ compatibility
  - Fixed JSON imports to use required 'with { type: "json" }' attribute (TS 5.7+ requirement)
  - No breaking changes to public API - all changes are internal or non-breaking

### Patch Changes

- Updated dependencies [11fa887]
  - @hyperlane-xyz/utils@20.1.0

## 0.6.0

### Minor Changes

- aeac943: Refactor AltVMJsonRpcTxSubmitter to implement ITransactionSubmitter. Remove ALT_VM_SUPPORTED_PROTOCOLS, createAltVMSubmitterFactories in favor of simplified getSubmitterByStrategy

### Patch Changes

- Updated dependencies [b3ebc08]
  - @hyperlane-xyz/utils@20.0.0

## 0.5.0

### Patch Changes

- @hyperlane-xyz/utils@19.13.0

## 0.4.0

### Minor Changes

- 38a1165c8: - Update CLI context `altVmSigners` to be a `ChainMap` instead of `AltVMSignerFactory`,
  - Update CLI context `altVmProviders` to be a `ChainMap` instead of `AltVMSignerFactory`.
  - Update all existing getter methods to use `mustTry`, instead of `assert`.
  - Delete `AltVMSupportedProtocols` and `AltVMProviderFactory`.
  - Move functions from `AltVMSignerFactory` to top-level functions.
  - Add `getMinGas` to Aleo, Cosmos and Radix ProtocolProvider.

### Patch Changes

- Updated dependencies [08cf7eca9]
- Updated dependencies [af2cd1729]
- Updated dependencies [e37100e2e]
  - @hyperlane-xyz/utils@19.12.0

## 0.3.0

### Minor Changes

- dd6260eea: Added the gatewayUrls and packageAddress fields to the ChainMetadataForAltVM

### Patch Changes

- @hyperlane-xyz/utils@19.11.0

## 0.2.0

### Minor Changes

- a0ba5e2fb: created new packages for provider package restructure
- 66bed7126: migrated AltVm modules to provider-sdk and deploy-sdk
- f604423b9: - Remove AltVMProviderFactory to new API in deploy-sdk (loadlProtocolProviders) and Registry singleton.
  - Add `chainId` and `rpcUrls` to `ChainMetadataForAltVM`. Add `CosmosNativeProtocolProvider` and `RadixProtocolProvider` to both cosmos-sdk and radix-sdk, respectively.
  - Add `forWarpRead`, `forCoreRead`, and `forCoreCheck` to signerMiddleware to enable chain resolving for these CLI functions.
  - Add `assert` after some `altVmProvider.get` calls in SDK configUtils.

### Patch Changes

- Updated dependencies [aad2988c9]
- Updated dependencies [c2a64e8c5]
  - @hyperlane-xyz/utils@19.10.0
