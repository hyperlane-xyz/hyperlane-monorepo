# Rebalancer Architecture Review

Date: 2026-06-12

Scope: `typescript/rebalancer` package. Findings are from local code inspection plus three read-only subagent slices covering core runtime, strategy/config, and bridges/tracking/tests.

Status: this document now doubles as the refactor plan and implementation log. The first performance-oriented implementation slice landed in PR #8880. The stacked follow-up PR implemented cycle context, shared planning/projection, and LiFi SDK isolation. The remaining work is deeper executor and test-fixture decomposition.

## Bottom Line

The package is functional and has useful high-level separation (`core`, `strategy`, `tracking`, `bridges`, `monitor`), but it is not the most optimal setup for performance, modularity, or testability.

The main issue is that important runtime state and side effects are hidden behind thin interfaces. `rebalance(routes)` can create intents, mutate inventory state, continue old work, ignore new routes, make RPC calls, send transactions, poll bridge APIs, record metrics, and swallow errors. This makes correctness hard to reason about and forces tests to mock large objects instead of asserting pure planning and state transitions.

Recommended direction: rearchitect around explicit cycle snapshots, pure-ish planning, typed execution plans, query-oriented tracking state, and small executor modules.

## Implemented In PR #8880

These slices directly target cycle latency and failure visibility without changing external config shape.

### Slice 1: Monitor Snapshot Parallelism

- Confirmed block tags are fetched concurrently for the unique warp-route chains in each monitor cycle.
- Bridged supply reads are fetched concurrently per token while preserving `tokensInfo` order and event shape.
- Benefit: monitor cycle duration is no longer the sum of every chain/token RPC read. The slowest read now dominates instead of all reads serially accumulating.

### Slice 2: Tracking Hot-Path Batching

- `InMemoryStore` now maintains lazy indexes and exposes indexed field lookups.
- `ActionTracker` can fetch actions by intent IDs and message IDs in batches.
- `InflightContextAdapter` fetches inventory intent actions in one grouped call instead of one action scan per intent.
- Delivery checks use bounded concurrency and destination block-tag caching.
- Benefit: tracker sync and inflight-context projection scale with indexed lookups and bounded IO rather than repeated full-store scans and serial RPCs.

### Slice 3: Orchestrator Non-Gating Side Effects

- Token metrics processing is best-effort and no longer blocks rebalancing cycles.
- Action-tracker sync runs each source independently and logs freshness by source instead of treating sync as one all-or-nothing operation.
- Executor throws now return failed route results for attempted routes rather than silently producing an empty result set.
- Benefit: slow metrics work and partial tracker-source failures do not stall the whole cycle, and failed execution paths are visible in cycle accounting.

## Implemented In This Stacked PR

These slices improve modularity and remove performance blockers from hidden mutable state and global SDK constraints.

### Slice 4: Explicit Cycle Context And Execution Status

- Added `RebalanceCycleContext` for balances, inventory balances, and confirmed block tags.
- Added `ExecutionSummary` and `CycleResult.status` so route failures and executor-level errors are surfaced as `success`, `partial`, or `failed`.
- The orchestrator now passes cycle context into rebalancers and no longer imports/casts to `InventoryRebalancer` to inject inventory balances.
- Benefit: execution accounting is explicit and testable, and inventory execution no longer depends on an orchestrator side channel.

### Slice 5: Shared Balance Projection And Route Planning

- Added `BalanceProjector` for pending transfers, pending rebalances, and proposed route projection.
- Added `RoutePlanner` helpers to centralize route materialization from surplus/deficit deltas and the resolved route execution matrix.
- Normalized bridge config into `RouteExecutionMatrix` so route execution config is resolved once instead of repeatedly merged with late non-null assertions.
- Benefit: strategy evaluation does less repeated config work, planning behavior is easier to unit test, and future strategy changes can target deltas instead of executable route construction.

### Slice 6: LiFi SDK Runner And Provider-Scope Locks

- Wrapped LiFi SDK calls and REST fetch behind an injected `LiFiSdkRunner`.
- Made execution locking follow the runner's provider scope: the default global LiFi SDK runner remains globally serialized, while injected scoped runners can serialize by source protocol and source chain.
- Tests now use deterministic runner fakes for quote/status/execution behavior instead of mutating global fetch or relying on SDK internals.
- Benefit: SDK global state is isolated behind a narrow seam, default execution avoids provider clobbering races, scoped runners can unlock safe source-chain concurrency, and bridge tests are faster and less brittle.

## Remaining Follow-Up TODOs

Keep the north star performance, but use the larger module split to make future performance work safer.

- [x] Add explicit `RebalanceCycleContext`, `ExecutionSummary`, and `CycleResult.status`.
- [x] Remove inventory state injection through `InventoryRebalancer.setInventoryBalances()` by passing cycle context into executors.
- [x] Normalize config into a resolved route execution matrix so strategies do not perform bridge/execution config lookups.
- [x] Move pending-transfer, pending-rebalance, and proposed-route projection into a shared `BalanceProjector`.
- [x] Introduce shared route planning and centralize route materialization after strategy evaluation.
- [ ] Move route filtering and metrics emission out of `BaseStrategy` into a dedicated `StrategyPlanner`.
- [ ] Split movable collateral execution into route validation, transaction preparation, chain transaction execution, and result recording modules.
- [ ] Split inventory execution into intent resolution, inventory planning, bridge capacity estimation, movement execution, and `transferRemote` execution modules.
- [x] Wrap LiFi SDK/global state behind an injected client/runner and make execution locking follow the runner's provider-state scope.
- [ ] Replace route-specific e2e deployment managers with a declarative fixture builder and shared deploy/enroll/seed helpers.
- [x] Add deterministic unit fakes for LiFi execution/status behavior separate from local integration bridge adapters.

## Current Shape

- `RebalancerService` owns lifecycle/setup and delegates daemon events to `RebalancerOrchestrator`.
- `Monitor` polls confirmed block tags, bridged supply, and inventory balances into `MonitorEvent`.
- `RebalancerOrchestrator` syncs tracking state, builds raw balances, asks a strategy for routes, and dispatches routes to rebalancers.
- `BaseStrategy` handles balance reservation, pending/proposed rebalance simulation, surplus/deficit matching, route materialization, filtering, and metrics.
- `Rebalancer` executes movable-collateral routes end to end.
- `InventoryRebalancer` executes inventory routes end to end, including active-intent continuation, bridge planning, external bridge execution, and `transferRemote`.
- `ActionTracker` owns explorer recovery, delivery checks, TTL/staleness, external bridge status, stores, and projection into inflight context.

## Highest Priority Problems

### 1. Hidden Runtime State And Lossy Results

Evidence:

- `RebalancerOrchestrator.executeRoutes()` casts `IRebalancer` to `InventoryRebalancer` and mutates inventory balances before calling `rebalance()`: `src/core/RebalancerOrchestrator.ts`.
- `InventoryRebalancer.rebalance()` ignores new routes when an active inventory intent exists, only takes the first route when no active intent exists, and keeps mutable `inventoryBalances` / `consumedInventory`: `src/core/InventoryRebalancer.ts`.
- `RebalancerOrchestrator.executeRoutes()` catches thrown executor errors and returns `[]`, so `executeWithTracking()` can report `0` failures for a failed executor path: `src/core/RebalancerOrchestrator.ts`.

Impact:

- Cycle result counts are not trustworthy for system-level failures.
- Interface says "rebalance these routes", but inventory execution may continue unrelated prior work.
- Tests must know concrete implementation details.

Recommendation:

- Add `RebalanceCycleContext` and pass it into executors:

```ts
type RebalanceCycleContext = {
  cycleId: string;
  balances: RawBalances;
  inventoryBalances?: ChainMap<bigint>;
  confirmedBlockTags?: ConfirmedBlockTags;
  trackerSnapshot: TrackerSnapshot;
};

interface RouteExecutor<R extends StrategyRoute> {
  executionType: R['executionType'];
  execute(
    routes: R[],
    context: RebalanceCycleContext,
  ): Promise<ExecutionSummary<R>>;
}
```

- Replace `ExecutionResult[]` as the only return shape with `ExecutionSummary`, including `status: 'success' | 'partial' | 'failed'`, per-route results, and system errors.
- Remove `InventoryRebalancer.setInventoryBalances()` and concrete casts from the orchestrator.

### 2. Polling And Tracking Are Serial / Full-Scan Heavy

Evidence:

- `Monitor.computeConfirmedBlockTags()` loops chains serially; token bridged supply reads also run serially.
- `ActionTracker.syncTransfers()` checks in-progress transfers one by one.
- `ActionTracker.syncRebalanceActions()` checks delivery one action at a time.
- `ActionTracker.syncInventoryMovementActions()` polls external bridge status serially.
- Store abstractions only expose broad scans like `getAll()`, `getByStatus()`, `getByDestination()`, forcing repeated filters and per-intent action lookups.

Impact:

- Cycle duration scales poorly with chain count, in-flight transfers, and active actions.
- Slow or flaky RPC/API calls extend or poison the whole cycle.
- Strategy runs on implicitly stale state after sync failure.

Recommendation:

- Create `StateSyncer` that returns an explicit `TrackerSnapshot` using `Promise.allSettled` and bounded concurrency.
- Group delivery checks by destination and compute confirmed block tag once per destination.
- Add query-oriented store APIs:

```ts
getActionsByIntentIds(intentIds: string[]): Promise<Map<string, RebalanceAction[]>>;
getCompletedAmountsByIntent(intentIds: string[]): Promise<Map<string, bigint>>;
getActiveIntentsWithActions(): Promise<Array<{ intent: RebalanceIntent; actions: RebalanceAction[] }>>;
getByMessageIds(messageIds: string[]): Promise<Map<string, RebalanceAction>>;
```

- Track freshness in the snapshot:

```ts
type TrackerSnapshot = {
  pendingTransfers: RouteWithContext[];
  pendingRebalances: RouteWithContext[];
  freshness: 'fresh' | 'partial' | 'stale';
  syncFailures: Array<{ source: string; error: string }>;
};
```

### 3. Strategy Planning Is Coupled To Execution Config

Evidence:

- `BaseStrategy.getRebalancingRoutes()` performs reservation, simulation, surplus/deficit matching, route materialization, filtering, and metrics.
- `WeightedStrategy`, `MinAmountStrategy`, and `CollateralDeficitStrategy` each repeat pending/proposed simulation before categorization.
- `CompositeStrategy` passes accumulated routes as `proposedRebalances`, requiring every strategy to understand composition internals.
- Config allows composite strategies with per-strategy chain subsets, but runtime builds raw balances from the union while `BaseStrategy.validateRawBalances()` rejects extra chains.
- Bridge execution config is normalized late with non-null assertions and casts in `StrategyFactory` / `bridgeUtils`.

Impact:

- Adding a strategy requires touching schema, factory, simulation behavior, and route materialization.
- Strategy tests cover too much orchestration behavior.
- Config validity is split between Zod and constructors.

Recommendation:

- Normalize config once into `StrategyPlanConfig`:

```ts
type StrategyPlanConfig = {
  chainSet: ChainName[];
  strategies: StrategyDescriptorInstance[];
  routeExecution: Record<ChainName, Record<ChainName, RouteExecutionConfig>>;
};

type RouteExecutionConfig =
  | {
      executionType: 'movableCollateral';
      bridge: Address;
      minAcceptedAmount: bigint;
    }
  | {
      executionType: 'inventory';
      externalBridge: ExternalBridgeType;
      minAcceptedAmount: bigint;
    };
```

- Move reservation and pending/proposed projection into `BalanceProjector`.
- Make strategies return desired deltas/targets, not executable routes:

```ts
interface StrategyEvaluator {
  evaluate(context: StrategyContext): DeltaPlan;
}
```

- Centralize route materialization/filtering after strategy evaluation.
- Either enforce identical chain sets for composite strategies at config load, or explicitly support subsets by passing each strategy only its configured balances.

### 4. Movable And Inventory Executors Are Monoliths

Evidence:

- `Rebalancer.rebalance()` creates intents, validates routes, gets quotes, populates txs, estimates gas, sends txs, parses receipts, records actions, and emits metrics.
- `validateRoute()` repeats signer/permission/destination/bridge checks per route.
- `InventoryRebalancer.executeRoute()` handles cost probes, fee-aware max transfer, source selection, bridge capacity, bridge execution, partial fulfillment, and `transferRemote`.

Impact:

- Hard to unit test without broad mocks.
- Repeated RPC validation wastes time within a cycle.
- Inventory behavior is a state machine encoded as imperative branches.

Recommendation:

- Split movable-collateral execution:
  - `MovableRouteValidator`
  - `MovableTxPreparer`
  - `ChainTxExecutor`
  - `RebalanceResultRecorder`
- Add per-cycle validation cache keyed by `origin:destination:bridge:token`.
- Split inventory execution into a state machine:
  - `InventoryIntentResolver`
  - `InventoryPlanner`
  - `BridgeCapacityEstimator`
  - `InventoryMovementExecutor`
  - `TransferRemoteExecutor`
- Model inventory steps explicitly:

```ts
type InventoryStep =
  | { kind: 'wait_for_deposit'; intentId: string }
  | { kind: 'transfer_remote'; route: InventoryRoute; amount: bigint }
  | { kind: 'bridge_inventory'; movements: InventoryMovementPlan[] }
  | { kind: 'complete_with_acceptable_loss'; intentId: string };
```

### 5. Metrics And External IO Can Gate Core Work

Evidence:

- `RebalancerOrchestrator.executeCycle()` awaits `Promise.all(metrics.processToken(...))` before tracker sync and strategy evaluation.
- `syncActionTracker()` wraps several sync operations in one catch and then continues with stale data without surfacing freshness to the planner.
- `ExplorerClient` has repeated fetch/error code, fixed `limit = 100`, no pagination, no request policy, and `any` response normalization.

Impact:

- Price/metrics failures can block rebalancing.
- Explorer/API/RPC failure policy is not explicit.
- Missing pagination risks invisible in-flight work above the limit.

Recommendation:

- Make metrics best-effort via `allSettled`, timeout, or async sink.
- Build a shared GraphQL requester with timeout, retry policy, typed response schemas, and pagination.
- Pass tracker freshness into strategy/execution. Decide policy explicitly:
  - `fresh`: execute normally.
  - `partial`: allow safe no-op or limited execution.
  - `stale`: skip execution unless manual override.

### 6. Bootstrap And Process Lifecycle Are Hard To Test

Evidence:

- `src/service.ts` mixes env parsing, key derivation, registry/provider construction, config merge, service start, and process exit.
- `RebalancerService.gracefulShutdown()` removes all process listeners and calls `process.exit(0)`.
- Tests monkeypatch static factory construction and fake orchestrator behavior.

Impact:

- Runtime assembly is difficult to test without process/global side effects.
- Signal handling can remove listeners not owned by this service.

Recommendation:

- Extract pure setup functions:
  - `loadRuntimeConfig(env)`
  - `deriveInventorySigners(env, config)`
  - `buildProviders(runtimeConfig)`
  - `buildRebalancerService(deps)`
- Keep `process.exit` only in the CLI entrypoint.
- Track and remove only signal handlers owned by this service.
- Inject factory, clock, and signal manager interfaces.

### 7. LiFi Adapter And Test Harness Limit Parallelism

Evidence:

- `LiFiBridge` uses process-global LiFi SDK config/provider mutation and serializes all executions behind `_executeLock`.
- LiFi tests mutate `globalThis.fetch`.
- E2E deployment managers duplicate topology/deploy/enroll/seed loops.
- `MockExternalBridge` is an integration bridge, not a lightweight fake: it estimates gas, sends real route txs, and instantiates a relayer in status checks.

Impact:

- Hard to test bridge behavior deterministically.
- Parallel bridge execution is globally limited even when independent.
- E2E suite setup is slower and drifts across route variants.

Recommendation:

- Introduce `LiFiClient` / `LiFiSdkRunner` with injected HTTP client and provider context.
- Replace global execution lock with per-source-chain or per-signer guard where needed.
- Split test bridge types:
  - `FakeExternalBridge` for deterministic unit tests.
  - `LocalWarpBridgeAdapter` for integration/e2e.
- Replace route-specific deployment managers with declarative fixture builder:

```ts
type RebalancerFixtureSpec = {
  topology: ChainName[];
  routeKind: 'erc20' | 'native' | 'mixed' | 'inventory';
  strategies: StrategyConfig[];
  seedBalances: Array<{ chain: ChainName; account: string; amount: bigint }>;
};
```

## Target Architecture

Proposed module boundaries:

```text
src/runtime/
  service.ts              # lifecycle only
  CycleRunner.ts          # singleflight, timeout, cycle ids, error boundary
  StateSyncer.ts          # monitor event + tracker sync -> CycleSnapshot

src/planning/
  StrategyPlanner.ts      # strategy order, projection, route materialization
  BalanceProjector.ts     # pending transfers/rebalances/proposed routes
  RouteMaterializer.ts    # deltas -> executable StrategyRoute[]
  RouteExecutionMatrix.ts # resolved origin/destination execution config

src/execution/
  ExecutionEngine.ts
  movable/
    RouteValidator.ts
    TxPreparer.ts
    ChainTxExecutor.ts
  inventory/
    InventoryPlanner.ts
    InventoryIntentResolver.ts
    BridgeCapacityEstimator.ts
    InventoryMovementExecutor.ts
    TransferRemoteExecutor.ts

src/tracking/
  ActionTracker.ts        # facade/coordinator
  ExplorerRecovery.ts
  DeliveryStatusSyncer.ts
  InventoryMovementStatusSyncer.ts
  IntentProjector.ts
  store/
    IndexedInMemoryStore.ts

src/config/
  schema.ts
  normalize.ts
  strategyRegistry.ts
  bridgeRegistry.ts
```

Cycle flow:

```text
Monitor event
  -> CycleRunner
  -> StateSyncer builds CycleSnapshot
  -> StrategyPlanner builds ExecutionPlan
  -> ExecutionEngine dispatches by executionType
  -> ResultRecorder updates tracker/metrics
  -> CycleResult includes status, failures, freshness, timings
```

## Implementation Plan

### Phase 0: Guardrails And Characterization

- Add tests for current lossy behavior before refactor:
  - executor throws -> cycle result reports failure
  - inventory active intent ignores new routes intentionally
  - composite chain subset config either fails early or works intentionally
- Add cycle timing logs/metrics around monitor polling, tracker sync, planning, execution.
- No behavior change except test coverage and observability.

### Phase 1: Explicit Cycle Context And Results

- Introduce `RebalanceCycleContext`, `ExecutionSummary`, and `CycleResult.status`.
- Change `IRebalancer.rebalance(routes)` to `execute(routes, context)` or add a parallel interface and migrate callers.
- Remove `InventoryRebalancer.setInventoryBalances()`.
- Make thrown executor errors count as failed cycle/system errors.

### Phase 2: Config Normalization And Strategy Planner

- Push static numeric checks into Zod.
- Add second validation pass for token/registry-dependent checks.
- Normalize route execution config into a per-origin/per-destination matrix.
- Decide and enforce composite chain-set policy.
- Move balance projection and route materialization out of strategy subclasses.

### Phase 3: Tracking Performance Refactor

- Add indexed store methods by intent, status, destination, and message id.
- Split `ActionTracker` into syncers/projectors with pure transition tests.
- Use bounded concurrency and grouped destination block tags for delivery checks.
- Return explicit `TrackerSnapshot` freshness/failures.

### Phase 4: Executor Split

- Split movable executor pipeline and add per-cycle route validation cache.
- Convert inventory execution into planner + step executors.
- Keep public behavior stable while making each step unit-testable.

### Phase 5: Bridge And Harness Cleanup

- Wrap LiFi SDK/global state behind injected client/runner.
- Replace global execution lock with narrower guard.
- Add deterministic `FakeExternalBridge`.
- Consolidate e2e harness into declarative fixture builder and shared deploy/enroll/seed helpers.

## Suggested Tests After Refactor

- Unit:
  - `BalanceProjector` pending transfer/rebalance cases.
  - `RouteMaterializer` min amount and execution config selection.
  - `TrackerSnapshot` projection from intents/actions/transfers.
  - `InventoryPlanner` branches: wait, direct transfer, partial transfer, bridge, acceptable loss.
  - `MovableRouteValidator` cache hits/misses.
- Integration:
  - `RebalancerService + CycleRunner + Orchestrator` with real planner and fake executors.
  - `ActionTracker` syncers with fake explorer/core/bridge clients.
  - LiFi adapter with injected fake SDK runner.
- E2E:
  - One movable-collateral route.
  - One inventory route with active partial intent continuation.
  - One composite strategy route proving chain-set policy and proposed-route projection.

## Pickup Notes

- Preserve current external config shape initially. Add normalized internal types behind `RebalancerConfig.load()`.
- Avoid compatibility shims inside strategy code; compatibility belongs at config normalization boundaries.
- Do not make metrics or Explorer availability a hard gate unless a freshness policy explicitly says execution is unsafe.
- Keep route execution idempotency tied to tracker state, not executor instance fields.
- Changes under this published package likely need a changeset once implementation changes behavior or public types.
