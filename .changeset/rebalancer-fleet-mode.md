---
'@hyperlane-xyz/rebalancer': minor
---

Added fleet mode (`REBALANCER_CONFIG_FILES`) that runs multiple warp-route rebalancers in one process with a shared execution lock, fresh inventory-balance refetch before inventory execution, an injectable inventory view seam, and a start-once metrics server.
