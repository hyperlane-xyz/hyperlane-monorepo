# @hyperlane-xyz/cosmos-sdk

## 23.0.0

### Patch Changes

- Updated dependencies [0b8c4ea]
- Updated dependencies [52fd0f8]
- Updated dependencies [a10cfc8]
  - @hyperlane-xyz/provider-sdk@1.2.1
  - @hyperlane-xyz/utils@23.0.0
  - @hyperlane-xyz/cosmos-types@23.0.0

## 22.0.0

### Minor Changes

- 7f31d77: Implemented hook artifact API for Cosmos. Added hook query functions, transaction builders, and artifact readers/writers for IGP and MerkleTree hooks. The CosmosHookArtifactManager provides factory methods for creating type-specific hook readers and writers using lazy query client initialization. Hook writers support creating new hooks and updating mutable configurations (IGP owner and gas configs). Existing provider and signer implementations were refactored to use the new shared query and transaction functions, reducing code duplication. Comprehensive e2e tests verify all hook operations following the established artifact API patterns.
- b0e9d48: Implemented ISM writers using the new artifact API for Cosmos. Added CosmosTestIsmWriter, CosmosMessageIdMultisigIsmWriter, CosmosMerkleRootMultisigIsmWriter, and CosmosRoutingIsmRawWriter classes. These writers support creating and updating ISMs on Cosmos chains, with routing ISM supporting full domain route management and ownership transfers. The CosmosIsmArtifactManager now provides functional createWriter() factory methods for all supported ISM types.
- 7f31d77: Migrated deploy-sdk to use Hook Artifact API, replacing AltVMHookReader and AltVMHookModule with unified reader/writer pattern. The migration adds deployment context support (mailbox address, nativeTokenDenom) for hook creation, following the same pattern as the ISM artifact migration. Key changes include new factory functions (createHookReader, createHookWriter), config conversion utilities (hookConfigToArtifact, shouldDeployNewHook), and removal of deprecated hook module classes.

### Patch Changes

- Updated dependencies [66ef635]
- Updated dependencies [7f31d77]
- Updated dependencies [3aec1c4]
- Updated dependencies [b892d63]
  - @hyperlane-xyz/utils@22.0.0
  - @hyperlane-xyz/provider-sdk@1.2.0
  - @hyperlane-xyz/cosmos-types@22.0.0

## 21.1.0

### Minor Changes

- db857b5: Fixed cosmos sdk e2e tests failing locally by marking type imports with the `type` keyword to preserve type imports when reading js files directly for local test runs
- 57a2053: Added `/testing` sub import path to expose testing utils for cosmos environments

### Patch Changes

- Updated dependencies [57a2053]
  - @hyperlane-xyz/provider-sdk@1.1.0
  - @hyperlane-xyz/cosmos-types@21.1.0
  - @hyperlane-xyz/utils@21.1.0

## 21.0.0

### Minor Changes

- ed10fc1: Introduced the Artifact API for ISM operations on AltVMs. The new API provides a unified interface for reading and writing ISM configurations across different blockchain protocols. Radix ISM readers and writers fully implemented; Cosmos ISM readers implemented. The generic `IsmReader` in deploy-sdk replaces the legacy `AltVMIsmReader` and supports recursive expansion of routing ISM configurations.

### Patch Changes

- Updated dependencies [239e1a1]
- Updated dependencies [ed10fc1]
- Updated dependencies [0bce4e7]
  - @hyperlane-xyz/provider-sdk@1.0.0
  - @hyperlane-xyz/utils@21.0.0
  - @hyperlane-xyz/cosmos-types@21.0.0

## 20.1.0

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
  - @hyperlane-xyz/provider-sdk@0.7.0
  - @hyperlane-xyz/cosmos-types@20.1.0

## 20.0.0

### Patch Changes

- Updated dependencies [b3ebc08]
- Updated dependencies [aeac943]
  - @hyperlane-xyz/utils@20.0.0
  - @hyperlane-xyz/provider-sdk@0.6.0
  - @hyperlane-xyz/cosmos-types@20.0.0

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
