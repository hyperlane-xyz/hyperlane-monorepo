# @hyperlane-xyz/deploy-sdk

## 1.2.1

### Patch Changes

- 0b8c4ea: Fixed hook update logic for warp routes. The warp route reader now properly reads hook addresses from deployed contracts instead of hardcoding zero address. Hook update idempotency check fixed to use deepEquals with config normalization instead of reference equality, preventing unnecessary redeployments when applying identical configs. Aleo provider updated to handle null/zero hook addresses correctly. Protocol capability check added to restrict hook updates to Aleo only. Comprehensive test suite added covering hook type transitions (none→MerkleTree, MerkleTree→IGP, MerkleTree→none), IGP config updates (gas configs, beneficiary), and idempotency validation.
- Updated dependencies [c8f6f6c]
- Updated dependencies [0b8c4ea]
- Updated dependencies [52fd0f8]
- Updated dependencies [a10cfc8]
- Updated dependencies [80f3635]
  - @hyperlane-xyz/aleo-sdk@23.0.0
  - @hyperlane-xyz/provider-sdk@1.2.1
  - @hyperlane-xyz/utils@23.0.0
  - @hyperlane-xyz/cosmos-sdk@23.0.0
  - @hyperlane-xyz/radix-sdk@23.0.0

## 1.2.0

### Minor Changes

- b0e9d48: Introduced artifact-based IsmWriter and migrated existing code to use it instead of AltVMIsmModule.
- 7f31d77: Migrated deploy-sdk to use Hook Artifact API, replacing AltVMHookReader and AltVMHookModule with unified reader/writer pattern. The migration adds deployment context support (mailbox address, nativeTokenDenom) for hook creation, following the same pattern as the ISM artifact migration. Key changes include new factory functions (createHookReader, createHookWriter), config conversion utilities (hookConfigToArtifact, shouldDeployNewHook), and removal of deprecated hook module classes.

### Patch Changes

- Updated dependencies [ade2653]
- Updated dependencies [8b3f8da]
- Updated dependencies [0acaa0e]
- Updated dependencies [7f31d77]
- Updated dependencies [b0e9d48]
- Updated dependencies [66ef635]
- Updated dependencies [7f31d77]
- Updated dependencies [3aec1c4]
- Updated dependencies [b892d63]
- Updated dependencies [44fbfd6]
  - @hyperlane-xyz/aleo-sdk@22.0.0
  - @hyperlane-xyz/cosmos-sdk@22.0.0
  - @hyperlane-xyz/utils@22.0.0
  - @hyperlane-xyz/provider-sdk@1.2.0
  - @hyperlane-xyz/radix-sdk@22.0.0

## 1.1.0

### Patch Changes

- Updated dependencies [db857b5]
- Updated dependencies [57a2053]
- Updated dependencies [57a2053]
- Updated dependencies [9c48ac8]
  - @hyperlane-xyz/cosmos-sdk@21.1.0
  - @hyperlane-xyz/provider-sdk@1.1.0
  - @hyperlane-xyz/aleo-sdk@21.1.0
  - @hyperlane-xyz/radix-sdk@21.1.0
  - @hyperlane-xyz/utils@21.1.0

## 1.0.0

### Major Changes

- 68310db: feat: aleo cli support

### Minor Changes

- 239e1a1: Migrate AltVm JsonSubmittor and FileSubmittor to deploy-sdk (from provider-sdk and cli, respectively)
- ed10fc1: Introduced the Artifact API for ISM operations on AltVMs. The new API provides a unified interface for reading and writing ISM configurations across different blockchain protocols. Radix ISM readers and writers fully implemented; Cosmos ISM readers implemented. The generic `IsmReader` in deploy-sdk replaces the legacy `AltVMIsmReader` and supports recursive expansion of routing ISM configurations.

### Patch Changes

- Updated dependencies [8006faf]
- Updated dependencies [68310db]
- Updated dependencies [239e1a1]
- Updated dependencies [ed10fc1]
- Updated dependencies [0bce4e7]
  - @hyperlane-xyz/aleo-sdk@21.0.0
  - @hyperlane-xyz/provider-sdk@1.0.0
  - @hyperlane-xyz/radix-sdk@21.0.0
  - @hyperlane-xyz/cosmos-sdk@21.0.0
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
  - @hyperlane-xyz/cosmos-sdk@20.1.0
  - @hyperlane-xyz/radix-sdk@20.1.0
  - @hyperlane-xyz/provider-sdk@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies [b3ebc08]
- Updated dependencies [aeac943]
  - @hyperlane-xyz/utils@20.0.0
  - @hyperlane-xyz/provider-sdk@0.6.0
  - @hyperlane-xyz/cosmos-sdk@20.0.0
  - @hyperlane-xyz/radix-sdk@20.0.0

## 0.5.0

### Minor Changes

- ae8ef4389: Fixed a bug in `AltVMHookModule` and `AltVMIsmModule` which prevented updates from an artifact type to a different one causing the update to fail

### Patch Changes

- Updated dependencies [ae8ef4389]
  - @hyperlane-xyz/radix-sdk@19.13.0
  - @hyperlane-xyz/cosmos-sdk@19.13.0
  - @hyperlane-xyz/utils@19.13.0
  - @hyperlane-xyz/provider-sdk@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [38a1165c8]
- Updated dependencies [08cf7eca9]
- Updated dependencies [af2cd1729]
- Updated dependencies [43b3756d9]
- Updated dependencies [e37100e2e]
  - @hyperlane-xyz/provider-sdk@0.4.0
  - @hyperlane-xyz/cosmos-sdk@19.12.0
  - @hyperlane-xyz/radix-sdk@19.12.0
  - @hyperlane-xyz/utils@19.12.0

## 0.3.0

### Patch Changes

- Updated dependencies [dd6260eea]
- Updated dependencies [dd6260eea]
  - @hyperlane-xyz/provider-sdk@0.3.0
  - @hyperlane-xyz/radix-sdk@19.11.0
  - @hyperlane-xyz/cosmos-sdk@19.11.0
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

- aad2988c9: Export Logger type from utils for explicit typing in deploy-sdk
- Updated dependencies [aad2988c9]
- Updated dependencies [c2a64e8c5]
- Updated dependencies [a97a9939c]
- Updated dependencies [a0ba5e2fb]
- Updated dependencies [66bed7126]
- Updated dependencies [f604423b9]
  - @hyperlane-xyz/utils@19.10.0
  - @hyperlane-xyz/cosmos-sdk@19.10.0
  - @hyperlane-xyz/radix-sdk@19.10.0
  - @hyperlane-xyz/provider-sdk@0.2.0
