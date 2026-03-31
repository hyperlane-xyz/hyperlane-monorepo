# @hyperlane-xyz/sealevel-sdk

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
