---
'@hyperlane-xyz/sdk': minor
---

An `extraSigners` field was added to `SolanaWeb3Transaction` and `TransferRemoteParams` to properly thread Sealevel keypairs through the typed transaction pipeline. WarpCore now generates and passes a `Keypair` for SolanaWeb3 transfers, and `SealevelHypTokenAdapter` consumes it instead of generating its own. `KeypairSvmTransactionSigner.signTransaction` was changed to use `partialSign` to preserve extra signer signatures across blockhash resubmits.
