---
'@hyperlane-xyz/ccip-server': patch
---

The `getCallsFromRevealMessage` offchain-lookup endpoint rejected a non-32-byte `origin_tx_hash`. Non-EVM origins such as Solana carry a 64-byte transaction signature, which previously failed the 32-byte hex guard with `Invalid origin_tx_hash` and left commit-reveal ICA messages from those origins permanently undeliverable. The `origin_tx_hash` hint, an optional EVM-only ICA-derivation optimization, is now resolved against the origin domain's protocol: EVM origins still fail closed on a malformed hash, while non-EVM origins ignore the hint and are served from the stored commitment record.
