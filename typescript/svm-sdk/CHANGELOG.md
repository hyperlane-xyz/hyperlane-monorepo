# @hyperlane-xyz/sealevel-sdk

## 28.1.0

### Patch Changes

- 5caac66: Added `crossCollateral` warp token type to the provider-sdk type system. All protocol SDK artifact managers were updated to handle the new type in their exhaustive switches.
- Updated dependencies [5caac66]
  - @hyperlane-xyz/provider-sdk@4.1.0
  - @hyperlane-xyz/utils@28.1.0

## 28.0.0

### Patch Changes

- Updated dependencies [83767b9]
- Updated dependencies [a6b7bf3]
  - @hyperlane-xyz/provider-sdk@4.0.0
  - @hyperlane-xyz/utils@28.0.0

## 27.1.0

### Patch Changes

- Updated dependencies [b892e61]
- Updated dependencies [b892e61]
- Updated dependencies [b892e61]
  - @hyperlane-xyz/provider-sdk@3.1.0
  - @hyperlane-xyz/utils@27.1.0

## 27.0.0

### Minor Changes

- 22cb5cb: The `@hyperlane-xyz/sealevel-sdk` package (renamed from `@hyperlane-xyz/svm-sdk`) was published as a Solana/SVM client for Hyperlane Sealevel programs. It provides `SealevelProtocolProvider`, `SealevelProvider`, and `SealevelSigner` implementing the AltVM provider-sdk interfaces, along with warp token readers/writers (native, synthetic, collateral), ISM readers/writers (multisig message-ID, test), hook readers/writers (IGP, merkle tree), BPF program deployment/upgrade plans, PDA derivation utilities, and account decoders. ISM and hook deployment are not yet functional.

  `SealevelProtocolProvider` was registered in the deploy-sdk for `ProtocolType.Sealevel`, and `ProtocolType.Sealevel` was added to the CLI's supported protocols list, enabling `hyperlane warp deploy` for Solana chains.

### Patch Changes

- @hyperlane-xyz/utils@27.0.0
- @hyperlane-xyz/provider-sdk@3.0.1
