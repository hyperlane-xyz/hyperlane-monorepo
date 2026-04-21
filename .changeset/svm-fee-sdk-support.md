---
'@hyperlane-xyz/provider-sdk': major
'@hyperlane-xyz/deploy-sdk': major
'@hyperlane-xyz/sealevel-sdk': minor
'@hyperlane-xyz/aleo-sdk': patch
'@hyperlane-xyz/cosmos-sdk': patch
'@hyperlane-xyz/radix-sdk': patch
'@hyperlane-xyz/starknet-core': patch
'@hyperlane-xyz/tron-sdk': patch
---

SVM fee program SDK support was added, enabling deployment and management of all 6 fee types (linear, regressive, progressive, offchainQuotedLinear, routing, crossCollateralRouting) on Solana/SVM chains.

**Breaking change:** `ProtocolProvider.createFeeArtifactManager()` now requires a `FeeReadContext` parameter. This ensures routed fee types (routing, CC routing) receive the domain/router context needed to discover non-enumerable route PDAs. All protocol SDK implementations were updated.

The SVM fee SDK includes:
- Readers and writers for all 6 fee types with full create/update support.
- Instruction builders for all 18 fee program instructions including runtime operations (QuoteFee, SubmitQuote, etc.).
- PDA derivation, Borsh codecs, and account decoders for the fee program's on-chain state.
- SvmFeeArtifactManager implementing IRawFeeArtifactManager, wired into SvmProtocolProvider.
