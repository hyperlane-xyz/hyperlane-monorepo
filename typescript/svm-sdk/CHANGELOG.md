# @hyperlane-xyz/sealevel-sdk

## 30.0.0

### Major Changes

- 2a9b135: SvmSigner send/confirm flow was refactored with block-height-based polling, client-side rebroadcast, structured blockhash error detection via @solana/errors, and double-execution prevention for processed transactions. Program deployment write stages are now sent in parallel batches with retry on failure. Breaking: DeployStage requires a new `kind` field (DeployStageKind discriminant).

### Patch Changes

- Updated dependencies [37255ba]
- Updated dependencies [7646819]
  - @hyperlane-xyz/provider-sdk@4.2.3
  - @hyperlane-xyz/utils@30.0.0

## 29.1.0

### Patch Changes

- @hyperlane-xyz/utils@29.1.0
- @hyperlane-xyz/provider-sdk@4.2.2

## 29.0.1

### Patch Changes

- @hyperlane-xyz/utils@29.0.1
- @hyperlane-xyz/provider-sdk@4.2.1

## 29.0.0

### Minor Changes

- f0a33c6: Added `serializeUnsignedTransaction` to produce base58-encoded unsigned v0 transactions and messages compatible with the Rust Sealevel CLI output. `transactionToPrintableJson` now includes `transactionBase58`, `messageBase58`, and `annotation` fields alongside the existing human-readable format.

### Patch Changes

- 084c6b6: The TypeScript packages were updated to support TypeScript 6.0 and to make ambient type loading explicit so the future TypeScript 7.0 upgrade is smoother.
- Updated dependencies [3c6b1ad]
- Updated dependencies [084c6b6]
  - @hyperlane-xyz/utils@29.0.0
  - @hyperlane-xyz/provider-sdk@4.2.0

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
