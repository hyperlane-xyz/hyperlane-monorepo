---
'@hyperlane-xyz/sealevel-sdk': minor
'@hyperlane-xyz/deploy-sdk': patch
'@hyperlane-xyz/cli': patch
---

The `@hyperlane-xyz/sealevel-sdk` package (renamed from `@hyperlane-xyz/svm-sdk`) was published as a hand-crafted Solana/SVM client for Hyperlane Sealevel programs. The package provides:

- **Protocol integration**: `SealevelProtocolProvider`, `SealevelProvider`, and `SealevelSigner` implementing the AltVM `ProtocolProvider`, `IProvider`, and `ISigner` interfaces for cross-VM SDK compatibility.
- **Warp token readers/writers**: `SvmNativeTokenReader/Writer`, `SvmSyntheticTokenReader/Writer`, and `SvmCollateralTokenReader/Writer` for deploying and managing warp routes on Solana, coordinated through `SvmWarpArtifactManager`.
- **ISM management**: `SealevelMessageIdMultisigIsmReader/Writer` and `SealevelTestIsmReader/Writer` for configuring Interchain Security Modules, coordinated through `SealevelIsmArtifactManager`. **Note: ISM deployment is not yet functional.**
- **Hook management**: `SealevelIgpHookReader/Writer` and `SealevelMerkleTreeHookReader/Writer` for configuring post-dispatch hooks (IGP, merkle tree), coordinated through `SealevelHookArtifactManager`. **Note: Hook deployment is not yet functional.**
- **Program deployment**: `createDeployProgramPlan` and `createUpgradeProgramPlan` for deploying and upgrading Solana BPF programs via the loader-v3 program.
- **PDA derivation utilities**: Functions for deriving all Hyperlane program PDAs (token, mailbox, IGP, ISM, validator announce, etc.).
- **Account codecs**: Binary decoders for on-chain Hyperlane program state (token accounts, multisig ISM, IGP).
- **Instruction builders**: Low-level Solana instruction constructors for token init, router enrollment, gas config, ISM/hook setup, and ownership transfer.
- **Testing utilities**: `SolanaContainer` for spinning up a local Solana validator via testcontainers for e2e tests.

`SealevelProtocolProvider` was registered in the deploy-sdk for `ProtocolType.Sealevel`, and `ProtocolType.Sealevel` was added to the CLI's supported protocols list, enabling `hyperlane warp deploy` for Solana chains.
