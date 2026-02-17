---
'@hyperlane-xyz/rebalancer': major
---

**Breaking**: `IActionTracker` interface was extended with new required query methods (`getTransfer`, `getRebalanceIntent`, `getRebalanceAction`, `getInProgressActions`) to support E2E test assertions against tracked state. External implementations of `IActionTracker` must implement these methods.

Extracted `RebalancerOrchestrator` from `RebalancerService` to separate polling orchestration from service lifecycle, improving testability. Fixed non-null assertion pattern on metrics and tightened `executeWithTracking` return type to `void`.

Added comprehensive E2E test harness with `TestRebalancer` builder, `ForkIndexer` for indexing Dispatch events from Anvil forks, and full E2E coverage for weighted, minAmount, collateral-deficit, and composite strategies.
