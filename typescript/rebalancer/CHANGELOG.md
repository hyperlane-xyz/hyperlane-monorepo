# @hyperlane-xyz/rebalancer

## 3.1.1

### Patch Changes

- Updated dependencies [521d42b]
  - @hyperlane-xyz/core@10.2.0
  - @hyperlane-xyz/metrics@0.1.8
  - @hyperlane-xyz/sdk@25.3.2
  - @hyperlane-xyz/utils@25.3.2
  - @hyperlane-xyz/provider-sdk@1.3.6

## 3.1.0

### Minor Changes

- aa6871b: Added configurable intent TTL to expire stale in-progress rebalance intents. Defaults to 7 days. Uses `send_occurred_at` from the explorer API for accurate TTL calculation.

### Patch Changes

- ff8c0f0: Fixed inventory rebalancer oscillation edge case where an intent with its final deposit fully in-flight (remaining === 0) was invisible to the rebalancer, potentially allowing contradictory intent creation.
  - @hyperlane-xyz/sdk@25.3.1
  - @hyperlane-xyz/metrics@0.1.7
  - @hyperlane-xyz/utils@25.3.1
  - @hyperlane-xyz/provider-sdk@1.3.5
  - @hyperlane-xyz/core@10.1.5

## 3.0.0

### Major Changes

- 1970a32: Added inventory rebalancing via external bridges (LiFi), enabling token rebalancing across chains where Hyperlane warp routes alone are insufficient. This is a breaking change to the config schema, type system, and tracking interfaces.

  ### Breaking: Config Schema
  - `RebalancerBridgeConfigSchema.bridge` changed from **required** to **optional** — inventory chains don't use on-chain bridge contracts
  - Added `executionType` field to chain config (`'movableCollateral' | 'inventory'`), defaults to `movableCollateral` for backward compatibility
  - Added `externalBridge` field to chain config (`'lifi'`) for specifying which external bridge to use
  - Added top-level `inventorySigner` field (required when any chain uses inventory execution)
  - Added top-level `externalBridges` config block with `LiFiBridgeConfigSchema` (`{ integrator, defaultSlippage? }`)
  - New Zod cross-field validations: `bridge` required for `movableCollateral` chains, `externalBridge` required for `inventory` chains, `inventorySigner` and `externalBridges.lifi` required when inventory chains exist

  ### Breaking: Route Types
  - **Deleted** `RebalanceRoute` type (was `StrategyRoute & { intentId }`)
  - **Deleted** `RebalanceExecutionResult` and `RebalanceMetrics` types
  - `StrategyRoute` changed from `Route & { bridge }` to discriminated union: `MovableCollateralRoute | InventoryRoute`, discriminated on `executionType`
  - Added `MovableCollateralRoute` (`{ executionType: 'movableCollateral', bridge }`) and `InventoryRoute` (`{ executionType: 'inventory', externalBridge }`)
  - Added `RouteWithContext` extending `Route` with `deliveredAmount` and `awaitingDeliveryAmount` for inventory intent tracking
  - `InflightContext.pendingRebalances` and `pendingTransfers` changed from `Route[]` to `RouteWithContext[]`

  ### Breaking: IRebalancer Interface
  - `IRebalancer` changed from non-generic `{ rebalance(routes: RebalanceRoute[]): Promise<RebalanceExecutionResult[]> }` to generic `IRebalancer<R extends Route, E extends ExecutionResult<R>>` with `rebalancerType` field
  - Added `ExecutionResult<R>` base type and specialized `MovableCollateralExecutionResult` / `InventoryExecutionResult`
  - Added `IMovableCollateralRebalancer` and `IInventoryRebalancer` type aliases
  - `PreparedTransaction.route` changed from `RebalanceRoute` to `MovableCollateralRoute & { intentId: string }`

  ### Breaking: IActionTracker Interface
  - `CreateRebalanceIntentParams`: added `executionMethod` and `externalBridge` fields
  - `CreateRebalanceActionParams`: added required `type: ActionType` field, `messageId` changed from required to optional, added `externalBridgeTransferId` and `externalBridgeId` fields
  - `RebalanceIntent`: removed `fulfilledAmount` field, added `executionMethod` and `externalBridge` fields
  - `RebalanceAction`: added required `type: ActionType` field, `messageId` changed from required to optional, added `externalBridgeTransferId` and `externalBridgeId` fields
  - New required methods on `IActionTracker`: `syncInventoryMovementActions()`, `getPartiallyFulfilledInventoryIntents()`, `getActionsByType()`, `getActionsForIntent()`, `getInflightInventoryMovements()`

  ### Breaking: Tracking Types
  - Added `ExecutionMethod` type (`'movable_collateral' | 'inventory'`)
  - Added `ActionType` type (`'rebalance_message' | 'inventory_movement' | 'inventory_deposit'`)
  - Added `PartialInventoryIntent` type for tracking partially fulfilled inventory intents

  ### Breaking: Public API Exports
  - Removed exports: `RebalanceRoute`, `RebalanceExecutionResult`
  - Added exports: `ExecutionResult`, `IInventoryRebalancer`, `IMovableCollateralRebalancer`, `InventoryExecutionResult`, `MovableCollateralExecutionResult`, `RebalancerType`, `InventoryRoute`, `MovableCollateralRoute`, `Route`, `ActionType`, `PartialInventoryIntent`, `isMovableCollateralConfig`, `isInventoryConfig`, `MovableCollateralBridgeConfig`, `InventoryBridgeConfig`

  ### New: InventoryRebalancer
  - `InventoryRebalancer` — implements `IInventoryRebalancer`, orchestrates external bridge transfers followed by `transferRemote` deposits
  - `IExternalBridge` interface with `quote()`, `execute()`, `getStatus()` methods and associated types (`BridgeQuoteParams`, `BridgeQuote`, `BridgeTransferResult`, `BridgeTransferStatus`)
  - `LiFiBridge` — LiFi SDK integration for route quoting, transaction execution, and status polling
  - `ExternalBridgeRegistry` — maps `ExternalBridgeType` to `IExternalBridge` implementations
  - `gasEstimation` utilities using viem `estimateGas` with configurable multiplier

  ### New: Integration
  - `RebalancerService` supports dual signing keys (`HYP_REBALANCER_KEY` + optional `HYP_INVENTORY_KEY`) with separate `MultiProvider` instances
  - `RebalancerContextFactory` expanded with `createRebalancers()` and bridge instance creation
  - `Monitor` extended with `InventoryMonitorConfig` and `fetchInventoryBalances()`
  - `RebalancerOrchestrator` dispatches routes to appropriate rebalancer via `Map<string, IRebalancer>` by type
  - Backward-compatible `HYP_KEY` fallback in service entry point

### Patch Changes

- 1970a32: Fixed inventory rebalancer to include tokenFeeQuote in transfer cost calculation, preventing UNPREDICTABLE_GAS_LIMIT failures when native token fees exceed tx gas costs.
- Updated dependencies [aea767c]
  - @hyperlane-xyz/sdk@25.3.0
  - @hyperlane-xyz/metrics@0.1.6
  - @hyperlane-xyz/utils@25.3.0
  - @hyperlane-xyz/provider-sdk@1.3.4
  - @hyperlane-xyz/core@10.1.5

## 2.0.0

### Major Changes

- c61d612: **Breaking**: `IActionTracker` interface was extended with new required query methods (`getTransfer`, `getRebalanceIntent`, `getRebalanceAction`, `getInProgressActions`) to support E2E test assertions against tracked state. External implementations of `IActionTracker` must implement these methods.

  Extracted `RebalancerOrchestrator` from `RebalancerService` to separate polling orchestration from service lifecycle, improving testability. Fixed non-null assertion pattern on metrics and tightened `executeWithTracking` return type to `void`.

  Added comprehensive E2E test harness with `TestRebalancer` builder, `ForkIndexer` for indexing Dispatch events from Anvil forks, and full E2E coverage for weighted, minAmount, collateral-deficit, and composite strategies.

### Minor Changes

- ccd638d: Improved shared RPC override handling across TypeScript services.

### Patch Changes

- Updated dependencies [215dff0]
- Updated dependencies [d2f75a1]
- Updated dependencies [360db52]
- Updated dependencies [18ec479]
- Updated dependencies [795d93e]
- Updated dependencies [e143956]
- Updated dependencies [ccd638d]
- Updated dependencies [c61d612]
- Updated dependencies [c2affe2]
  - @hyperlane-xyz/sdk@25.2.0
  - @hyperlane-xyz/utils@25.2.0
  - @hyperlane-xyz/metrics@0.1.5
  - @hyperlane-xyz/core@10.1.5
  - @hyperlane-xyz/provider-sdk@1.3.3

## 1.0.3

### Patch Changes

- Updated dependencies [b930534]
- Updated dependencies [a18d0e6]
  - @hyperlane-xyz/sdk@25.1.0
  - @hyperlane-xyz/utils@25.1.0
  - @hyperlane-xyz/metrics@0.1.4
  - @hyperlane-xyz/core@10.1.5
  - @hyperlane-xyz/provider-sdk@1.3.2

## 1.0.2

### Patch Changes

- Updated dependencies [52ce778]
- Updated dependencies [aaabbad]
  - @hyperlane-xyz/utils@25.0.0
  - @hyperlane-xyz/sdk@25.0.0
  - @hyperlane-xyz/core@10.1.5
  - @hyperlane-xyz/metrics@0.1.3
  - @hyperlane-xyz/provider-sdk@1.3.1

## 1.0.1

### Patch Changes

- 8c80288: ActionTracker now uses MultiProtocolCore instead of HyperlaneCore for message delivery checks, enabling support for all VM types. Registry addresses are validated at startup to ensure mailbox is present.
- Updated dependencies [57461b2]
- Updated dependencies [d580bb6]
- Updated dependencies [50868ce]
- Updated dependencies [b05e9f8]
- Updated dependencies [f44c2b4]
- Updated dependencies [9dc71fe]
- Updated dependencies [bde05e9]
- Updated dependencies [d0b8c24]
- Updated dependencies [4de5071]
  - @hyperlane-xyz/utils@24.0.0
  - @hyperlane-xyz/sdk@24.0.0
  - @hyperlane-xyz/provider-sdk@1.3.0
  - @hyperlane-xyz/core@10.1.5
  - @hyperlane-xyz/metrics@0.1.2

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
