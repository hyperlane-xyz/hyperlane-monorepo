---
"@hyperlane-xyz/sdk": patch
---

Fixed HypNative token checker failing in CI environments by passing `from` address as the third parameter to `estimateGas` instead of inside the transaction object.
