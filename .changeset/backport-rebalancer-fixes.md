---
'@hyperlane-xyz/rebalancer': patch
---

blockTag was changed to use raw eth_blockNumber RPC to bypass stale provider cache. SnapshotHelper was extracted for e2e snapshot management with timeout/retry logic.
