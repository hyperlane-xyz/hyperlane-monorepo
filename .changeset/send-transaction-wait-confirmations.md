---
'@hyperlane-xyz/sdk': minor
---

Added optional `waitConfirmations` parameter to `sendTransaction()` and `handleTx()` methods in MultiProvider. This allows callers to specify a custom number of confirmations or a block tag like "finalized" or "safe" to wait for before returning. Added `waitForBlockTag()` helper method that polls until the tagged block number reaches the transaction's block number. Exported new `SendTransactionOptions` interface from SDK.
