---
"@hyperlane-xyz/sdk": minor
---

Extracted shared gas estimation utilities: `estimateHandleGasForRecipient()` for `handle()` calls and `estimateCallGas()` for individual contract calls. Added `HyperlaneCore.estimateHandleGas()` accepting minimal params. Refactored `InterchainAccount.estimateIcaHandleGas()` to use shared utilities.
