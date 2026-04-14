# @hyperlane-xyz/provider-sdk

## 4.3.3

### Patch Changes

- @hyperlane-xyz/utils@31.2.0

## 4.3.2

### Patch Changes

- @hyperlane-xyz/utils@31.1.0

## 4.3.1

### Patch Changes

- Updated dependencies [d5168fc]
  - @hyperlane-xyz/utils@31.0.1

## 4.3.0

### Minor Changes

- 44626fb: Enabled SVM cross-collateral token deployments in the CLI. Added `crossCollateral` to supported Alt-VM token types, allowing `warp deploy`, `warp combine`, and `warp apply` to work with SVM CC routes. Extracted `computeCrossCollateralRouterUpdates` into provider-sdk for cross-protocol reuse. Fixed CC-only gas preservation for domains transitioning from remote routers.

### Patch Changes

- @hyperlane-xyz/utils@31.0.0

## 4.2.5

### Patch Changes

- @hyperlane-xyz/utils@30.1.1

## 4.2.4

### Patch Changes

- @hyperlane-xyz/utils@30.1.0

## 4.2.3

### Patch Changes

- 37255ba: Starknet AltVM follow-up behavior was fixed across the CLI toolchain. Warp apply/update paths now preserve existing Starknet hook and ISM settings when config leaves them unset or uses empty addresses, zero-address hook and ISM references are normalized as unset during provider artifact conversion, and core mailbox bootstrap only passes through existing hook addresses for Starknet while other AltVMs keep zero-address placeholders.
- Updated dependencies [7646819]
  - @hyperlane-xyz/utils@30.0.0

## 4.2.2

### Patch Changes

- @hyperlane-xyz/utils@29.1.0

## 4.2.1

### Patch Changes

- @hyperlane-xyz/utils@29.0.1

## 4.2.0

### Patch Changes

- 084c6b6: The TypeScript packages were updated to support TypeScript 6.0 and to make ambient type loading explicit so the future TypeScript 7.0 upgrade is smoother.
- Updated dependencies [3c6b1ad]
- Updated dependencies [084c6b6]
  - @hyperlane-xyz/utils@29.0.0

## 4.1.0

### Minor Changes

- 5caac66: Added `crossCollateral` warp token type to the provider-sdk type system. All protocol SDK artifact managers were updated to handle the new type in their exhaustive switches.

### Patch Changes

- @hyperlane-xyz/utils@28.1.0

## 4.0.0

### Minor Changes

- 83767b9: Removed `AltVMCoreModule`, `AltVMCoreReader`, and `coreModuleProvider` from deploy-sdk in favor of the new core artifact API (`CoreWriter`, `createCoreReader`). Added `coreConfigToArtifact` and `coreResultToDeployedAddresses` helpers to provider-sdk. Updated CLI core deploy and read commands to use the new API.
- a6b7bf3: Added `toDeployedOrUndefined` utility and `UnsetArtifactAddress` type to the artifact module. Extended `ProtocolProvider` interface with `createMailboxArtifactManager` and `createValidatorAnnounceArtifactManager` methods. Updated `mailboxArtifactToDerivedCoreConfig` to handle UNDERIVED artifacts with zero addresses gracefully. Widened `DerivedCoreConfig` fields to accept `UnsetArtifactAddress`.

### Patch Changes

- @hyperlane-xyz/utils@28.0.0

## 3.1.0

### Minor Changes

- b892e61: Added mailbox and validator announce artifact interfaces in provider-sdk. The new interfaces establish the contract for mailbox and validator announce artifacts, including MailboxConfig with ISM and Hook artifact references, ValidatorAnnounceConfig with mailbox address reference, and raw artifact variants for protocol implementation use.
- b892e61: CoreArtifactReader was implemented as a composite artifact reader for core deployments. It takes a mailbox address and returns a fully expanded MailboxArtifactConfig with all nested ISM and hook artifacts read from chain. A backward-compatible deriveCoreConfig() method was provided. A mailboxArtifactToDerivedCoreConfig conversion helper was added to mailbox.ts and ismArtifactToDerivedConfig was exported from the ISM reader.

### Patch Changes

- Updated dependencies [b892e61]
  - @hyperlane-xyz/utils@27.1.0

## 3.0.1

### Patch Changes

- @hyperlane-xyz/utils@27.0.0

## 3.0.0

### Major Changes

- 1d116d8: Added Tron ProtocolType & deprecated Tron TechnicalStack. Add support for TronLink wallet in the widgets.

### Patch Changes

- Updated dependencies [06aacac]
- Updated dependencies [1d116d8]
  - @hyperlane-xyz/utils@26.0.0

## 2.0.0

### Major Changes

- 840fb33: Deprecated AltVM warp module classes were removed from deploy-sdk and replaced with the artifact API.

  deploy-sdk removed public exports:
  - AltVMWarpModule (use createWarpTokenWriter instead)
  - AltVMWarpRouteReader (use createWarpTokenReader instead)
  - AltVMDeployer (use createWarpTokenWriter per-chain instead)
  - warpModuleProvider (no longer needed)
  - ismConfigToArtifact (moved to @hyperlane-xyz/provider-sdk/ism)
  - shouldDeployNewIsm (moved to @hyperlane-xyz/provider-sdk/ism)

  provider-sdk breaking change: warpConfigToArtifact no longer accepts pre-built ismArtifact/hookArtifact parameters; ISM and hook conversion is now handled internally from the config.

  cosmos-sdk: name and symbol for warp tokens without on-chain metadata were changed from empty strings to 'Unknown'.

  CLI and SDK were updated to use the new artifact API via createWarpTokenWriter and createWarpTokenReader.

### Minor Changes

- e197331: Added WarpTokenReader and WarpTokenWriter for artifact API-based warp token operations.

  New exports:
  - createWarpTokenReader: Factory for reading warp tokens
  - createWarpTokenWriter: Factory for creating/updating warp tokens
  - WarpTokenReader: Artifact for reading warp tokens with nested ISM/hook expansion
  - WarpTokenWriter: Artifact for deploying and updating warp tokens

  Protocol providers now support createWarpArtifactManager method.

### Patch Changes

- @hyperlane-xyz/utils@25.5.0

## 1.4.1

### Patch Changes

- @hyperlane-xyz/utils@25.4.1

## 1.4.0

### Minor Changes

- 1f021bf: Implemented warp token artifact API for Radix. Added warp token artifact types to provider-sdk including `WarpArtifactConfig`, `RawWarpArtifactConfig`, and conversion functions between Config API and Artifact API formats. The artifact types support collateral and synthetic warp tokens with proper handling of nested ISM artifacts and domain ID conversions. Implemented Radix warp token readers and writers for both collateral and synthetic tokens, with artifact manager providing factory methods for type-specific operations. Writers support creating new warp tokens with ISM configuration, enrolling remote routers, and transferring ownership. Update operations generate transaction arrays for ISM changes, router enrollment/unenrollment, and ownership transfers. Native token type is not supported on Radix.

### Patch Changes

- Updated dependencies [1f021bf]
  - @hyperlane-xyz/utils@25.4.0

## 1.3.6

### Patch Changes

- @hyperlane-xyz/utils@25.3.2

## 1.3.5

### Patch Changes

- @hyperlane-xyz/utils@25.3.1

## 1.3.4

### Patch Changes

- @hyperlane-xyz/utils@25.3.0

## 1.3.3

### Patch Changes

- Updated dependencies [360db52]
- Updated dependencies [ccd638d]
  - @hyperlane-xyz/utils@25.2.0

## 1.3.2

### Patch Changes

- Updated dependencies [b930534]
  - @hyperlane-xyz/utils@25.1.0

## 1.3.1

### Patch Changes

- Updated dependencies [52ce778]
  - @hyperlane-xyz/utils@25.0.0

## 1.3.0

### Minor Changes

- 9dc71fe: Added forward-compatible enum validation to prevent SDK failures when the registry contains new enum values. Added `Unknown` variants to `ProtocolType`, `TokenType`, `IsmType`, `HookType`, `ExplorerFamily`, and `ChainTechnicalStack` enums. Exported `KnownProtocolType` and `DeployableTokenType` for type-safe mappings.

### Patch Changes

- Updated dependencies [57461b2]
- Updated dependencies [d580bb6]
- Updated dependencies [9dc71fe]
- Updated dependencies [bde05e9]
  - @hyperlane-xyz/utils@24.0.0

## 1.2.1

### Patch Changes

- 0b8c4ea: Fixed hook update logic for warp routes. The warp route reader now properly reads hook addresses from deployed contracts instead of hardcoding zero address. Hook update idempotency check fixed to use deepEquals with config normalization instead of reference equality, preventing unnecessary redeployments when applying identical configs. Aleo provider updated to handle null/zero hook addresses correctly. Protocol capability check added to restrict hook updates to Aleo only. Comprehensive test suite added covering hook type transitions (none→MerkleTree, MerkleTree→IGP, MerkleTree→none), IGP config updates (gas configs, beneficiary), and idempotency validation.
- Updated dependencies [52fd0f8]
- Updated dependencies [a10cfc8]
  - @hyperlane-xyz/utils@23.0.0

## 1.2.0

### Minor Changes

- 7f31d77: Migrated deploy-sdk to use Hook Artifact API, replacing AltVMHookReader and AltVMHookModule with unified reader/writer pattern. The migration adds deployment context support (mailbox address, nativeTokenDenom) for hook creation, following the same pattern as the ISM artifact migration. Key changes include new factory functions (createHookReader, createHookWriter), config conversion utilities (hookConfigToArtifact, shouldDeployNewHook), and removal of deprecated hook module classes.

### Patch Changes

- Updated dependencies [66ef635]
- Updated dependencies [3aec1c4]
- Updated dependencies [b892d63]
  - @hyperlane-xyz/utils@22.0.0

## 1.1.0

### Minor Changes

- 57a2053: Added optional gasPrice field to `TestChainMetadata` type

### Patch Changes

- @hyperlane-xyz/utils@21.1.0

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
