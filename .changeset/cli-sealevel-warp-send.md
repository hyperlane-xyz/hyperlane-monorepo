---
'@hyperlane-xyz/cli': minor
'@hyperlane-xyz/sdk': patch
---

Added Sealevel (Solana) support to the `warp send` command, enabling cross-VM transfers between EVM and SVM chains. Fixed SVM transaction signing to use `partialSign` and preserve pre-set blockhashes.
