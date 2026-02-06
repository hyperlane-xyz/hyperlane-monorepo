---
'@hyperlane-xyz/sdk': patch
---

Fixed nonce collision in EvmTokenFeeModule by deploying sub-fee contracts sequentially instead of in parallel.
