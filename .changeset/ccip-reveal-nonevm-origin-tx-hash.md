---
'@hyperlane-xyz/ccip-server': patch
---

The `getCallsFromRevealMessage` offchain-lookup endpoint no longer rejected a non-32-byte `origin_tx_hash`. Non-EVM origins such as Solana carry a 64-byte transaction signature, which previously failed the 32-byte hex guard with `Invalid origin_tx_hash` and left commit-reveal ICA messages from those origins permanently undeliverable. The hash is now treated as an optional EVM-only ICA-derivation hint and ignored when it is not a valid 32-byte hash, so the reveal is served from the stored commitment record.
