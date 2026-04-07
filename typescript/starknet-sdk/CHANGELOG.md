# @hyperlane-xyz/starknet-sdk

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
