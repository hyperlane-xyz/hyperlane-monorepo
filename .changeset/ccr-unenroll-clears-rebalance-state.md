---
'@hyperlane-xyz/core': patch
---

`CrossCollateralRouter` now clears a domain's rebalance recipient and allowed bridges when its last cross-collateral route is unenrolled and the domain has no classic remote router, so an unenrolled route no longer retains rebalance authority.
