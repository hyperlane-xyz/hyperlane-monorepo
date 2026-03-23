---
"@hyperlane-xyz/sealevel-sdk": minor
---

Added `serializeUnsignedTransaction` to produce base58-encoded unsigned v0 transactions and messages compatible with the Rust Sealevel CLI output. `transactionToPrintableJson` now includes `transactionBase58`, `messageBase58`, and `annotation` fields alongside the existing human-readable format.
