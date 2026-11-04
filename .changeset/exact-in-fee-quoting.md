---
'@hyperlane-xyz/core': minor
---

Added exact-in fee quoting for warp route fee contracts. A new `IExactInFee` capability interface exposes `quoteTransferRemoteFrom`, which inverts the exact-out `quoteTransferRemote`: given a spend budget in the collateral token, it returns the largest deliverable `amount` such that `amount + fee(amount) <= budget`.

- Added the `IExactInFee` interface to `ITokenBridge.sol` and a `BaseFee` default that reverts with `ExactInNotSupported` for fee curves that are not invertible.
- Implemented a closed-form capped-linear inverse in `LinearFee` (no binary search), reused by `OffchainQuotedLinearFee`, which resolves the active linear params through the same transient → standing → immutable cascade as the forward quote before inverting.
- Extended `ICrossCollateralFee` / `CrossCollateralRoutingFee` with router-aware `quoteTransferRemoteFromTo`, and added budget-based `quoteTransferRemoteFrom` / `transferRemoteFrom` (with a `minAmountOut` slippage guard) to `CrossCollateralRouter`, plus the delegating override on `PredicateCrossCollateralRouterWrapper`.
