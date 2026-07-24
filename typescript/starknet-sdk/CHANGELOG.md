# @hyperlane-xyz/starknet-sdk

## 28.1.4

### Patch Changes

- Updated dependencies [961a89d]
  - @hyperlane-xyz/provider-sdk@7.2.0
  - @hyperlane-xyz/starknet-core@38.0.0
  - @hyperlane-xyz/utils@38.0.0

## 28.1.3

### Patch Changes

- Updated dependencies [df34a68]
- Updated dependencies [cc4bdb6]
- Updated dependencies [31f8b51]
- Updated dependencies [97e8ca1]
  - @hyperlane-xyz/provider-sdk@7.1.0
  - @hyperlane-xyz/starknet-core@37.0.0
  - @hyperlane-xyz/utils@37.0.0

## 28.1.2

### Patch Changes

- aa41ce4: SVM fee program management was added to the SVM SDK with full create, read, and update support for all 6 fee types (linear, regressive, progressive, offchainQuotedLinear, routing, crossCollateralRouting). The provider-sdk fee types were refactored with a FeeParams discriminated union (bps vs raw), PascalCase FeeType/FeeStrategyType values, expanded DerivedFeeConfig with resolved bigint fields, and a required FeeReadContext parameter on createFeeArtifactManager. Shared BPS fee utilities (computeBps, bpsToRawFeeParams, constants) were consolidated into provider-sdk as the single source of truth — sdk and svm-sdk now import from provider-sdk. The EVM SDK TokenFeeType was converted from enum to const object for structural compatibility. Legacy pre-fee program bytes were preserved for upgrade testing. The repeated account-decoding boilerplate in the fee and token decoders was consolidated into a shared decodeDiscriminatedAccount helper.
- Updated dependencies [9cd7606]
- Updated dependencies [aa41ce4]
- Updated dependencies [2f9d783]
- Updated dependencies [9bdab1d]
  - @hyperlane-xyz/utils@36.0.0
  - @hyperlane-xyz/provider-sdk@7.0.0
  - @hyperlane-xyz/starknet-core@36.0.0

## 28.1.1

### Patch Changes

- @hyperlane-xyz/starknet-core@35.2.0
- @hyperlane-xyz/utils@35.2.0
- @hyperlane-xyz/provider-sdk@6.1.1

## 28.1.0

### Minor Changes

- d1b6f0a: Added new hook deploy command

### Patch Changes

- a911f17: Starknet read calls defaulted to the latest accepted block instead of the pending block, so warp token reads no longer fail against RPC providers that reject `block_id: "pending"`.
- Updated dependencies [d1b6f0a]
  - @hyperlane-xyz/provider-sdk@6.1.0
  - @hyperlane-xyz/starknet-core@35.1.0
  - @hyperlane-xyz/utils@35.1.0

## 28.0.9

### Patch Changes

- Updated dependencies [da1cfb1]
  - @hyperlane-xyz/utils@35.0.1
  - @hyperlane-xyz/provider-sdk@6.0.4
  - @hyperlane-xyz/starknet-core@35.0.1

## 28.0.8

### Patch Changes

- @hyperlane-xyz/starknet-core@35.0.0
- @hyperlane-xyz/utils@35.0.0
- @hyperlane-xyz/provider-sdk@6.0.3

## 28.0.7

### Patch Changes

- @hyperlane-xyz/starknet-core@34.0.0
- @hyperlane-xyz/utils@34.0.0
- @hyperlane-xyz/provider-sdk@6.0.2

## 28.0.6

### Patch Changes

- @hyperlane-xyz/starknet-core@33.1.1
- @hyperlane-xyz/utils@33.1.1
- @hyperlane-xyz/provider-sdk@6.0.1

## 28.0.5

### Patch Changes

- Updated dependencies [bfe4d2e]
  - @hyperlane-xyz/provider-sdk@6.0.0
  - @hyperlane-xyz/starknet-core@33.1.0
  - @hyperlane-xyz/utils@33.1.0

## 28.0.4

### Patch Changes

- b864cca: Multi-VM fee type support was added to provider-sdk and deploy-sdk. Fee types (linear, regressive, progressive, offchainQuotedLinear, routing, crossCollateralRouting) were defined with Config API and Artifact API variants. FeeReader and FeeWriter with required FeeReadContext were added to deploy-sdk. Fee was integrated into warp types and the warp writer update flow. All protocol providers received createFeeArtifactManager stubs.
- Updated dependencies [b864cca]
- Updated dependencies [1f918d0]
  - @hyperlane-xyz/provider-sdk@5.1.0
  - @hyperlane-xyz/utils@33.0.2
  - @hyperlane-xyz/starknet-core@33.0.2

## 28.0.3

### Patch Changes

- @hyperlane-xyz/starknet-core@33.0.1
- @hyperlane-xyz/utils@33.0.1
- @hyperlane-xyz/provider-sdk@5.0.3

## 28.0.2

### Patch Changes

- @hyperlane-xyz/starknet-core@33.0.0
- @hyperlane-xyz/utils@33.0.0
- @hyperlane-xyz/provider-sdk@5.0.2

## 28.0.1

### Patch Changes

- @hyperlane-xyz/starknet-core@32.0.1
- @hyperlane-xyz/utils@32.0.1
- @hyperlane-xyz/provider-sdk@5.0.1

## 28.0.0

### Major Changes

- 3dc6367: Core query methods (getIsmType, getRoutingIsm, getHookType, etc.) were removed from the IProvider interface and extracted into standalone query functions in each SDK. isMessageDelivered was kept on the interface to enforce all providers implement it.

  Starknet get\*Transaction methods were extracted into standalone tx builder functions (mailbox-tx.ts, ism-tx.ts, hook-tx.ts, warp-tx.ts) with their own parameter types, removing the dependency on provider-sdk Req/Res types.

  Tron and Aleo providers and signers had all get\*Transaction and action methods removed. Old e2e tests replaced with artifact API equivalents.

  76 Req/Res types were removed from provider-sdk altvm.ts, reducing it from 587 to 243 lines.

- fa08f2a: IProvider and ISigner interfaces were slimmed to their minimal surface. IProvider was reduced from 53 to 22 query-only methods by removing all get\*Transaction methods. ISigner was reduced from 36 to 5 infrastructure methods by removing all action methods (createMailbox, setDefaultIsm, enrollRemoteRouter, etc.). Transaction building is now handled exclusively by artifact managers using concrete class methods or standalone helper functions.

  Throwing stubs were removed from SVM, Cosmos, Radix, and Starknet provider/signer implementations. Old action-method-based e2e tests were replaced with artifact API equivalents. Cosmos routing ISM writer was fixed to handle domain route updates correctly via remove + re-add.

### Patch Changes

- Updated dependencies [3dc6367]
- Updated dependencies [fa08f2a]
  - @hyperlane-xyz/provider-sdk@5.0.0
  - @hyperlane-xyz/starknet-core@32.0.0
  - @hyperlane-xyz/utils@32.0.0

## 27.2.10

### Patch Changes

- @hyperlane-xyz/starknet-core@31.2.1
- @hyperlane-xyz/utils@31.2.1
- @hyperlane-xyz/provider-sdk@4.3.4

## 27.2.9

### Patch Changes

- @hyperlane-xyz/starknet-core@31.2.0
- @hyperlane-xyz/utils@31.2.0
- @hyperlane-xyz/provider-sdk@4.3.3

## 27.2.8

### Patch Changes

- cf3f11c: Starknet devnet switched to instant per-transaction block mining and starknet.js polling interval reduced for fast block times, speeding up e2e tests ~5x.
  - @hyperlane-xyz/starknet-core@31.1.0
  - @hyperlane-xyz/utils@31.1.0
  - @hyperlane-xyz/provider-sdk@4.3.2

## 27.2.7

### Patch Changes

- Updated dependencies [d5168fc]
  - @hyperlane-xyz/utils@31.0.1
  - @hyperlane-xyz/provider-sdk@4.3.1
  - @hyperlane-xyz/starknet-core@31.0.1

## 27.2.6

### Patch Changes

- Updated dependencies [44626fb]
  - @hyperlane-xyz/provider-sdk@4.3.0
  - @hyperlane-xyz/starknet-core@31.0.0
  - @hyperlane-xyz/utils@31.0.0

## 27.2.5

### Patch Changes

- @hyperlane-xyz/starknet-core@30.1.1
- @hyperlane-xyz/utils@30.1.1
- @hyperlane-xyz/provider-sdk@4.2.5

## 27.2.4

### Patch Changes

- @hyperlane-xyz/starknet-core@30.1.0
- @hyperlane-xyz/utils@30.1.0
- @hyperlane-xyz/provider-sdk@4.2.4

## 27.2.3

### Patch Changes

- 516c829: Fixed on-chain token metadata reading for Starknet chains by fetching the contract's actual ABI instead of using a hardcoded HYP_ERC20 artifact. Proxy contracts are now resolved to their implementation class ABI, and `shouldFallbackStorageRead` was unified into a shared utility so both protocol-fee and validator-announce managers handle the same set of RPC errors (including `-32000` / "method not allowed").
- 37255ba: Starknet AltVM follow-up behavior was fixed across the CLI toolchain. Warp apply/update paths now preserve existing Starknet hook and ISM settings when config leaves them unset or uses empty addresses, zero-address hook and ISM references are normalized as unset during provider artifact conversion, and core mailbox bootstrap only passes through existing hook addresses for Starknet while other AltVMs keep zero-address placeholders.
- Updated dependencies [37255ba]
- Updated dependencies [7646819]
  - @hyperlane-xyz/provider-sdk@4.2.3
  - @hyperlane-xyz/utils@30.0.0
  - @hyperlane-xyz/starknet-core@30.0.0

## 27.2.2

### Patch Changes

- @hyperlane-xyz/starknet-core@29.1.0
- @hyperlane-xyz/utils@29.1.0
- @hyperlane-xyz/provider-sdk@4.2.2

## 27.2.1

### Patch Changes

- @hyperlane-xyz/starknet-core@29.0.1
- @hyperlane-xyz/utils@29.0.1
- @hyperlane-xyz/provider-sdk@4.2.1

## 27.2.0

### Minor Changes

- 09d6760: Added Starknet artifact API support across the TypeScript AltVM toolchain. The new `@hyperlane-xyz/starknet-sdk` package provides Starknet protocol, signer, provider, ISM, hook, mailbox, validator announce, and end-to-end test coverage. Deploy SDK protocol loading and the CLI context/signer flows were updated so Starknet chains can be resolved and used through the shared AltVM paths.

### Patch Changes

- Updated dependencies [3c6b1ad]
- Updated dependencies [084c6b6]
  - @hyperlane-xyz/utils@29.0.0
  - @hyperlane-xyz/provider-sdk@4.2.0
  - @hyperlane-xyz/starknet-core@29.0.0
