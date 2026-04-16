---
'@hyperlane-xyz/sealevel-sdk': patch
'@hyperlane-xyz/cli': patch
'@hyperlane-xyz/sdk': patch
---

Fixed Solana-origin `warp send` by adding a legacy @solana/web3.js to @solana/kit transaction conversion layer. SDK adapters return legacy Transaction objects, but the SvmSigner expects kit-format instructions. The conversion handles instruction format translation, compute budget preservation, and extra signer (Keypair→TransactionSigner) conversion. SvmReceipt was extended with transaction meta (logs) fetched after confirmation so extractMessageIds works for Solana transfers.
