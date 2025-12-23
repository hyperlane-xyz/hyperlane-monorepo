# @hyperlane-xyz/deploy-sdk

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
