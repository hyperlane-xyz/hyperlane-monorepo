---
'@hyperlane-xyz/rebalancer': major
---

Inflight-aware rebalancing system with ActionTracker, new strategies, and type safety improvements.

Breaking changes:
- IRebalancer.rebalance() now returns RebalanceExecutionResult[] instead of void
- IStrategy.getRebalancingRoutes() accepts optional inflightContext parameter
- IStrategy now requires a name property
- RebalancingRoute renamed to StrategyRoute with required bridge field
- MonitorEvent now includes confirmedBlockTags for confirmed block queries

New features:
- ActionTracker for tracking pending transfers and rebalance actions with Explorer integration
- CollateralDeficitStrategy for just-in-time rebalancing based on pending inbound transfers
- CompositeStrategy for chaining multiple strategies with coordination
- BaseStrategy inflight-aware methods: reserveCollateral(), getAvailableBalance()
- Query balances at confirmed blocks to sync with Explorer indexing
- Strategy config supports array format for composing multiple strategies (backwards compatible)

Bug fixes:
- Record failure metrics when rebalance results contain failures
- Treat missing Dispatch event as rebalance failure
- Fix CompositeStrategy oscillation by separating proposed from pending rebalances
