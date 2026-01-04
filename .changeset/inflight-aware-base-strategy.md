---
'@hyperlane-xyz/rebalancer': minor
---

BaseStrategy is extended with inflight-aware rebalancing capabilities and bridge configuration support. RebalancingRoute extended with optional bridge field for bridge selection. Added three protected methods: reserveCollateral() to prevent draining collateral needed for incoming transfers, simulatePendingRebalances() for optional balance simulation, and filterRebalances() to filter routes based on actual balance sufficiency. The getRebalancingRoutes() method updated to accept optional inflightContext and integrate the new methods. getCategorizedBalances() signature updated to accept optional pendingRebalances parameter. BaseStrategy, WeightedStrategy, and MinAmountStrategy constructors extended with optional bridges parameter (ChainMap<Address[]>) to store configured bridge addresses per chain.
