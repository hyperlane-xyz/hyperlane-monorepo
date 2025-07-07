---
'@hyperlane-xyz/core': major
---

Add LP interface to collateral routers

The `balanceOf` function has been removed from `TokenRouter` to remove ambiguity between `LpCollateralRouter.balanceOf`.

To migrate, use the new `FungibleTokenRouter.token()` to get an `IERC20` compliant address that you can call `balanceOf` on.
