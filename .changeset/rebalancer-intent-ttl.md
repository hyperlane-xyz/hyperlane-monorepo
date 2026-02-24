---
'@hyperlane-xyz/rebalancer': minor
---

Added configurable intent TTL to expire stale in-progress rebalance intents. Defaults to 2 hours. Uses `send_occurred_at` from the explorer API for accurate TTL calculation.
