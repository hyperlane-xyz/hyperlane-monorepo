---
"@hyperlane-xyz/rebalancer": patch
---

Improved rebalancer cycle performance by parallelizing monitor reads, batching tracked-action lookups, bounding delivery-status sync concurrency, and making token metrics processing best-effort.
