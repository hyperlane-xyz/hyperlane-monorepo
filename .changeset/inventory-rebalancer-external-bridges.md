---
'@hyperlane-xyz/rebalancer': major
---

Added inventory rebalancing via external bridges (LiFi), enabling token rebalancing across chains where Hyperlane warp routes alone are insufficient. This is a breaking change to the config schema, type system, and tracking interfaces.

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
