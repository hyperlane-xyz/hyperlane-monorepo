---
"@hyperlane-xyz/rebalancer": minor
---

Added inflight-aware strategy decorators (WithInflightGuard, WithSemaphore) and MessageTracker infrastructure to prevent overlapping rebalance operations. The decorators skip rebalancing when inflight messages are detected via Explorer API or when semaphore timers haven't expired.
