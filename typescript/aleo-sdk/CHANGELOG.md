# @hyperlane-xyz/aleo-sdk

## 23.0.0

### Major Changes

- 80f3635: feat: aleo nexus ui support

### Patch Changes

- c8f6f6c: Fixed routing ISM creation to correctly transfer ownership to the correct owner.
- 0b8c4ea: Fixed hook update logic for warp routes. The warp route reader now properly reads hook addresses from deployed contracts instead of hardcoding zero address. Hook update idempotency check fixed to use deepEquals with config normalization instead of reference equality, preventing unnecessary redeployments when applying identical configs. Aleo provider updated to handle null/zero hook addresses correctly. Protocol capability check added to restrict hook updates to Aleo only. Comprehensive test suite added covering hook type transitions (none→MerkleTree, MerkleTree→IGP, MerkleTree→none), IGP config updates (gas configs, beneficiary), and idempotency validation.
- a10cfc8: ISM update test coverage was improved by creating a shared test factory that works across AltVM protocols (Cosmos, Aleo, Radix). The factory supports explicit test skipping configuration through a `skipTests` parameter, making protocol-specific limitations clear in test configuration rather than hidden in implementation.

  Aleo address handling was fixed to properly support ISM unsetting. The `isZeroishAddress` regex now matches Aleo null addresses both with and without program ID prefix. The `fromAleoAddress` helper was updated to handle addresses without the '/' separator. The `getSetTokenIsmTransaction` method now converts zero addresses to `ALEO_NULL_ADDRESS` before processing.

- Updated dependencies [0b8c4ea]
- Updated dependencies [52fd0f8]
- Updated dependencies [a10cfc8]
  - @hyperlane-xyz/provider-sdk@1.2.1
  - @hyperlane-xyz/utils@23.0.0

## 22.0.0

### Minor Changes

- ade2653: Implemented hook artifact API for Aleo. Added hook query functions, transaction builders, and artifact readers/writers for IGP and MerkleTree hooks. The AleoHookArtifactManager provides factory methods for creating type-specific hook readers and writers, with optional mailbox address that is validated only when creating writers for deployment. Hook writers support creating new hooks and updating mutable configurations (IGP owner and gas configs). Existing provider implementation was refactored to use the new shared query and transaction functions, reducing code duplication. Comprehensive e2e tests verify all hook operations following the established artifact API patterns.
- 8b3f8da: Implemented ISM writers for Aleo SDK. Added Test ISM, MessageId Multisig ISM, and Routing ISM writers with full CRUD support through the artifact API.
- 0acaa0e: The Aleo SDK e2e test infrastructure was refactored to use testcontainers and expose reusable testing utilities for client packages. A new testing module (`@hyperlane-xyz/aleo-sdk/testing`) exports test chain metadata, node management functions, and signer creation helpers following the Cosmos SDK pattern. The testcontainers library replaced docker-compose for automatic container lifecycle management with proper port binding and environment configuration. A global test setup file handles before/after hooks for starting and stopping the devnode. All 54 e2e tests pass with the new infrastructure, and the shell script was simplified to only set environment variables while testcontainers manages the container.
- 7f31d77: Migrated deploy-sdk to use Hook Artifact API, replacing AltVMHookReader and AltVMHookModule with unified reader/writer pattern. The migration adds deployment context support (mailbox address, nativeTokenDenom) for hook creation, following the same pattern as the ISM artifact migration. Key changes include new factory functions (createHookReader, createHookWriter), config conversion utilities (hookConfigToArtifact, shouldDeployNewHook), and removal of deprecated hook module classes.

### Patch Changes

- 44fbfd6: fix: aleo wasm runtime error
- Updated dependencies [66ef635]
- Updated dependencies [7f31d77]
- Updated dependencies [3aec1c4]
- Updated dependencies [b892d63]
  - @hyperlane-xyz/utils@22.0.0
  - @hyperlane-xyz/provider-sdk@1.2.0

## 21.1.0

### Minor Changes

- 9c48ac8: Fixed aleo sdk e2e tests failing locally by marking type imports with the `type` keyword to preserve type imports when reading js files directly for local test runs

### Patch Changes

- Updated dependencies [57a2053]
  - @hyperlane-xyz/provider-sdk@1.1.0
  - @hyperlane-xyz/utils@21.1.0

## 21.0.0

### Major Changes

- 68310db: feat: aleo cli support

### Minor Changes

- 8006faf: Implemented the new artifact API for reading Aleo ISMs. Added `AleoIsmArtifactManager` with readers for Test ISM, Message ID Multisig ISM, and Routing ISM. Fixed TEST_ISM type constant to match on-chain contract.

### Patch Changes

- ed10fc1: Introduced the Artifact API for ISM operations on AltVMs. The new API provides a unified interface for reading and writing ISM configurations across different blockchain protocols. Radix ISM readers and writers fully implemented; Cosmos ISM readers implemented. The generic `IsmReader` in deploy-sdk replaces the legacy `AltVMIsmReader` and supports recursive expansion of routing ISM configurations.
- Updated dependencies [239e1a1]
- Updated dependencies [ed10fc1]
- Updated dependencies [0bce4e7]
  - @hyperlane-xyz/provider-sdk@1.0.0
  - @hyperlane-xyz/utils@21.0.0

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

## 20.0.0

### Patch Changes

- Updated dependencies [b3ebc08]
- Updated dependencies [aeac943]
  - @hyperlane-xyz/utils@20.0.0
  - @hyperlane-xyz/provider-sdk@0.6.0

## 19.13.0

### Patch Changes

- @hyperlane-xyz/utils@19.13.0
- @hyperlane-xyz/provider-sdk@0.5.0

## 19.12.0

### Patch Changes

- Updated dependencies [38a1165c8]
- Updated dependencies [08cf7eca9]
- Updated dependencies [af2cd1729]
- Updated dependencies [e37100e2e]
  - @hyperlane-xyz/provider-sdk@0.4.0
  - @hyperlane-xyz/utils@19.12.0

## 19.11.0

### Patch Changes

- Updated dependencies [dd6260eea]
  - @hyperlane-xyz/provider-sdk@0.3.0
  - @hyperlane-xyz/utils@19.11.0
