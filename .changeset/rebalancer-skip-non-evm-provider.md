---
'@hyperlane-xyz/rebalancer': patch
---

Provider initialization in `RebalancerContextFactory.create()` was restricted to EVM chains only. Non-EVM warp route chains (e.g. StarkNet, Sealevel) are now skipped, preventing crashes from ethers v5 rejecting non-numeric chainIds.
