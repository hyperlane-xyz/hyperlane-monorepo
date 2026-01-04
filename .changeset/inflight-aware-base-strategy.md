---
'@hyperlane-xyz/rebalancer': minor
---

BaseStrategy is extended with inflight-aware rebalancing capabilities. RebalancingRoute extended with optional bridge field for bridge selection. Added three protected methods: reserveCollateral() to prevent draining collateral needed for incoming transfers, simulatePendingRebalances() for optional balance simulation, and filterRebalances() to filter routes based on actual balance sufficiency. The getRebalancingRoutes() method updated to accept optional inflightContext and integrate the new methods. getCategorizedBalances() signature updated to accept optional pendingRebalances parameter. WeightedStrategy and MinAmountStrategy updated to match new signature.
