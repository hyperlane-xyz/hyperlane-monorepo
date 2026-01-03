---
"@hyperlane-xyz/rebalancer": minor
---

Wired up ActionTracker into RebalancerService. Added explorerUrl and rebalancerAddress config options. When configured, the RebalancerContextFactory creates a real ActionTracker with ExplorerClient and HyperlaneCore for inflight message tracking; otherwise falls back to the stub implementation.
