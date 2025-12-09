# @hyperlane-xyz/provider-sdk

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
