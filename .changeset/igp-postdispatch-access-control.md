---
'@hyperlane-xyz/core': minor
---

Added `latestDispatchedId` message integrity check to IGP `postDispatch` and split fee collection into `_collectNative` / `_collectToken`. Made `payForGas(feeToken)` payable to support both native and ERC20 fee paths.
