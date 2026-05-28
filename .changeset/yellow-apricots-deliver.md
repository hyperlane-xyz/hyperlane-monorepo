---
"@hyperlane-xyz/sdk": patch
---

Fixed max transfer simulation and fee display for native-token warp routes by reverting to the minimal-amount fallback in getLocalTransferFee for non-predicate flows.
