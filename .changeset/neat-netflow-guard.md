---
"@hyperlane-xyz/core": minor
---

- Added a net-flow rate-limited warp hook ISM that caps a router's net collateral outflow per day at a basis-point fraction of its live TVL, installed as both the router's hook and its ISM so symmetric flow nets out.
- Moved the token-bucket capacity shared with `DelayedFlowRouter` — sized as a bps fraction of native balance, synthetic supply, or collateral balance — into a `TvlRateLimited` base that both contracts extend.
- `RateLimited` buckets now report full at the current capacity until first consumed or credited, so a limiter deployed before its pool is funded starts full on first use instead of snapshotting a zero deploy-time capacity.
- The threshold basis points must now be strictly below 100%.
- Added a `MailboxClient._isProcessing` helper that binds a check to the message being delivered in the current transaction; the net-flow ISM uses it as its inbound flow guard.
