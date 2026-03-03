---
'@hyperlane-xyz/rebalancer': patch
---

blockTag uses raw eth_blockNumber RPC to bypass stale provider cache. Extracted SnapshotHelper for e2e snapshot management with timeout/retry logic.
