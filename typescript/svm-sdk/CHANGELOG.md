# @hyperlane-xyz/sealevel-sdk

## 31.0.1

### Patch Changes

- Updated dependencies [d5168fc]
  - @hyperlane-xyz/utils@31.0.1
  - @hyperlane-xyz/provider-sdk@4.3.1

## 31.0.0

### Patch Changes

- 44626fb: Enabled SVM cross-collateral token deployments in the CLI. Added `crossCollateral` to supported Alt-VM token types, allowing `warp deploy`, `warp combine`, and `warp apply` to work with SVM CC routes. Extracted `computeCrossCollateralRouterUpdates` into provider-sdk for cross-protocol reuse. Fixed CC-only gas preservation for domains transitioning from remote routers.
- eaac4ab: The sealevel ISM deploy flow was hardened by waiting for deployed programs to become visible and retrying initialization on chains that acknowledge deploys before the program is invokable.
- Updated dependencies [44626fb]
  - @hyperlane-xyz/provider-sdk@4.3.0
  - @hyperlane-xyz/utils@31.0.0

## 30.1.1

### Patch Changes

- @hyperlane-xyz/utils@30.1.1
- @hyperlane-xyz/provider-sdk@4.2.5

## 30.1.0

### Minor Changes

- 95c331e: Added cross-collateral token support to the SVM SDK, including create, read, and update operations for cross-collateral warp routes.

### Patch Changes

- b643062: Fixed serialized transaction output using the local keypair as fee payer instead of the actual authority (e.g. Squads vault). Added explicit feePayer field to SvmTransaction and set it on all update paths. Refactored IGP instruction builders to accept Address instead of TransactionSigner so the on-chain owner is used in serialized transactions.
  - @hyperlane-xyz/utils@30.1.0
  - @hyperlane-xyz/provider-sdk@4.2.4

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
