---
'@hyperlane-xyz/sdk': patch
---

Fixed `ProxyAdmin address is undefined` error when deploying unproxied OFT (collateralOft) warp routes. The `createHookUpdateTxs` method now skips hook updates when the hook address is the `AddressZero` sentinel value set by the warp route reader for unproxied contracts.
