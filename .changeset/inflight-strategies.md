---
"@hyperlane-xyz/rebalancer": minor
---

Added inflight-aware rebalancing infrastructure with ActionTracker interface and adapter pattern. Strategies now receive InflightContext containing pending transfers and rebalances, enabling smarter rebalancing decisions that avoid duplicating in-progress operations.
