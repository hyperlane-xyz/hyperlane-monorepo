---
'@hyperlane-xyz/core': minor
---

`DelayedFlowRouter` was added: an amount-sensitive hook + ISM that pairs with a warp route to delay cross-chain withdrawals proportionally when net flow exceeds a configurable fraction of the pool. It extends `TimelockRouter` + `RateLimited`, crediting its bucket 1:1 on local dispatches and deriving a per-message delay (capped at `maxDelay`) from a soft-consume at preverify time. `TimelockRouter` was refactored for extension: `postDispatch` and `_handle` are now overridable end-to-end via the leaf helpers `_TimelockRouter_dispatchPreverify` and `_TimelockRouter_commitReadyAt`. `RateLimited` exposes `maxCapacity()` as virtual so subclasses may back it dynamically (with the refill rate derived automatically), adds `_credit` / `_consume` primitives, and uses `Math.mulDiv` for the token-bucket math.
