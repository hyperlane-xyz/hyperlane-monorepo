---
"@hyperlane-xyz/core": minor
---

- Added a net-flow rate-limited warp hook ISM that caps a router's net collateral outflow per day at a basis-point fraction of its live TVL, installed as both the router's hook and its ISM so symmetric flow nets out.
- Moved the token-bucket capacity shared with `DelayedFlowRouterHookIsm` — sized as a bps fraction of native balance, synthetic supply, or collateral balance — into a `TvlRateLimited` base that both contracts extend.
- `TvlRateLimited` limiters report full at the current capacity until first consumed or credited, so a limiter deployed before its pool is funded starts full on first use instead of snapshotting a zero deploy-time capacity. The init flag lives in a hashed storage slot, leaving the layout of `RateLimited` and its deployed consumers unchanged.
- The threshold basis points are validated via an overridable
  `TvlRateLimited._validateThresholdBps`: reject-mode limiters (`NetFlow`)
  require strictly below 100% (a 100% cap collapses on the synthetic
  post-burn supply), while delay-mode `DelayedFlowRouterHookIsm` permits up to 100%
  since over-limit messages are delayed rather than reverted.
- Added a `MailboxClient._isProcessing` helper that binds a check to the message being delivered in the current transaction; the net-flow ISM uses it as its inbound flow guard.
- `TvlRateLimited` now sizes the collateral/native capacity on non-reclaimable collateral — the router's balance minus its LP-reclaimable pool (`totalAssets()`) — via a reusable `LpCollateral.effectiveCollateralBalance` library, so reversible ERC4626 `deposit`/`redeem`/`donate` on the `LpCollateralRouter`-based routers are capacity-neutral and can no longer inflate the limit; only genuinely locked collateral and irreversible transfers size it. Collateral routers that are not `LpCollateralRouter` vaults are unsupported and revert on the read.
- Documented that the synthetic (`totalSupply`) capacity basis shifts with the mint/burn being metered: inbound mints raise the capacity and refill rate, and burn-first outbound metering caps the largest single outbound at `S·thresholdBps / (BPS + thresholdBps)`.
