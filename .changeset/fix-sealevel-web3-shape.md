---
'@hyperlane-xyz/sealevel-sdk': patch
---

Fixed Sealevel signer compatibility with web3-style transactions by normalizing `programId` / `keys[].pubkey` instruction shapes before serialization and signing.
