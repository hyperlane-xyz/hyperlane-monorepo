---
'@hyperlane-xyz/rebalancer': patch
---

SnapshotHelper was extracted for shared e2e snapshot reset with timeout/retry logic. blockTag was changed to use raw eth_blockNumber RPC to bypass stale provider cache. TestHelpers race condition in getFirstMonitorEvent() was fixed with a settled flag.
