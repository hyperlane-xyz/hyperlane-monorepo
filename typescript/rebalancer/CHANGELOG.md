# @hyperlane-xyz/rebalancer

## 1.0.0

### Major Changes

- 0e1e48a: Inflight-aware rebalancing system with ActionTracker, new strategies, and type safety improvements.

  Breaking changes:

  - IRebalancer.rebalance() returned RebalanceExecutionResult[] instead of void
  - IStrategy.getRebalancingRoutes() accepted optional inflightContext parameter
  - IStrategy required a name property
  - RebalancingRoute renamed to StrategyRoute with required bridge field
  - MonitorEvent included confirmedBlockTags for confirmed block queries

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

### Minor Changes

- 8ad7e65: Implemented ActionTracker for inflight-message-aware rebalancing. The ActionTracker tracked three entity types: user warp transfers (Transfer), rebalance intents (RebalanceIntent), and rebalance actions (RebalanceAction). It provided startup recovery by querying the Explorer for inflight messages, periodic sync operations to check message delivery status on-chain, and a complete API for creating and managing rebalance intents and actions. The implementation included a generic store interface (IStore) with an InMemoryStore implementation, comprehensive unit tests, and integration with ExplorerClient for querying inflight messages.
- 3bd911e: Added CollateralDeficitStrategy for just-in-time rebalancing. This strategy detected collateral deficits (negative effective balances from pending user transfers) and proposed fast rebalances using configured bridges. Modified reserveCollateral() to allow negative values for deficit detection.
- 16ff4a9: Added CompositeStrategy for chaining multiple rebalancing strategies. Routes from earlier strategies were passed as pending rebalances to later strategies for coordination. Strategy config used array format - single strategy is an array with 1 element. Also unified schema types by making bridgeLockTime optional and added name property to IStrategy interface for better logging.
- 96eba9b: BaseStrategy is extended with inflight-aware rebalancing capabilities and bridge configuration support. RebalancingRoute extended with optional bridge field for bridge selection. Added three protected methods: reserveCollateral() to prevent draining collateral needed for incoming transfers, simulatePendingRebalances() for optional balance simulation, and filterRebalances() to filter routes based on actual balance sufficiency. The getRebalancingRoutes() method updated to accept optional inflightContext and integrate the new methods. getCategorizedBalances() signature updated to accept optional pendingRebalances parameter. BaseStrategy, WeightedStrategy, and MinAmountStrategy constructors extended with optional bridges parameter (ChainMap<Address[]>) to store configured bridge addresses per chain.

### Patch Changes

- Updated dependencies [d1d90d2]
- Updated dependencies [52fd0f8]
- Updated dependencies [7c22cff]
- Updated dependencies [0b8c4ea]
- Updated dependencies [52fd0f8]
- Updated dependencies [52fd0f8]
- Updated dependencies [a10cfc8]
- Updated dependencies [6ddef74]
- Updated dependencies [80f3635]
- Updated dependencies [576cd95]
- Updated dependencies [9aa93f4]
- Updated dependencies [42b72c3]
- Updated dependencies [a5d6cae]
  - @hyperlane-xyz/sdk@23.0.0
  - @hyperlane-xyz/provider-sdk@1.2.1
  - @hyperlane-xyz/utils@23.0.0
  - @hyperlane-xyz/metrics@0.1.1
  - @hyperlane-xyz/core@10.1.5

## 0.1.2

### Patch Changes

- b892d63: Migrated to use shared utilities from `@hyperlane-xyz/metrics` package, eliminating duplicate metric server implementations and ensuring consistent Prometheus metric collection across all services.
- 66ef635: Added `mapAllSettled` helper to @hyperlane-xyz/utils for typed parallel operations with key-based error tracking. Migrated Promise.allSettled patterns across sdk, cli, infra, and rebalancer packages to use the new helper.
- 223fd7f: Suppressed harmless startup warnings via pnpm patches instead of runtime suppression. The bigint-buffer native bindings warning and node-fetch .data deprecation warning are now patched at the source, avoiding the need for --no-warnings flags or console.warn overrides.
- Updated dependencies [c6a6d5f]
- Updated dependencies [4c58992]
- Updated dependencies [99948bc]
- Updated dependencies [99948bc]
- Updated dependencies [b0e9d48]
- Updated dependencies [66ef635]
- Updated dependencies [7f31d77]
- Updated dependencies [7a0a9e4]
- Updated dependencies [3aec1c4]
- Updated dependencies [b892d63]
  - @hyperlane-xyz/sdk@22.0.0
  - @hyperlane-xyz/utils@22.0.0
  - @hyperlane-xyz/provider-sdk@1.2.0
  - @hyperlane-xyz/metrics@0.1.0
  - @hyperlane-xyz/core@10.1.5

## 0.1.1

### Patch Changes

- Updated dependencies [57a2053]
  - @hyperlane-xyz/provider-sdk@1.1.0
  - @hyperlane-xyz/sdk@21.1.0
  - @hyperlane-xyz/utils@21.1.0
  - @hyperlane-xyz/core@10.1.5

## 0.1.0

### Minor Changes

- bc8b22f: Moved rebalancer-specific type definitions from `@hyperlane-xyz/sdk` to `@hyperlane-xyz/rebalancer`. Updated CLI and infra imports to use the new location. The rebalancer package is now self-contained and doesn't pollute the SDK with rebalancer-specific types.
- 9963e0e: feat: separate rebalancer package

  - Extract rebalancer logic from CLI into dedicated `@hyperlane-xyz/rebalancer` package
  - New package supports both manual CLI execution and continuous daemon mode for K8s deployments
  - CLI now imports from new package, maintaining backward compatibility for manual rebalancing

### Patch Changes

- Updated dependencies [c08fa32]
- Updated dependencies [68310db]
- Updated dependencies [b6b206d]
- Updated dependencies [239e1a1]
- Updated dependencies [bc8b22f]
- Updated dependencies [ed10fc1]
- Updated dependencies [0bce4e7]
  - @hyperlane-xyz/sdk@21.0.0
  - @hyperlane-xyz/provider-sdk@1.0.0
  - @hyperlane-xyz/utils@21.0.0
  - @hyperlane-xyz/core@10.1.4
