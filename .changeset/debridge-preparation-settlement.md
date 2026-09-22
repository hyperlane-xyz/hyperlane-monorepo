---
'@hyperlane-xyz/rebalancer': patch
'@hyperlane-xyz/tron-sdk': patch
---

Validated provider-retained source-swap surplus against committed amounts and supported designated DLN solvers. Added unsigned order preparation, on-chain fee and decimal checks, and bounded refresh after stale approvals. Required matching finalized source and destination order evidence before declaring settlement, including Tron solidified blocks.
