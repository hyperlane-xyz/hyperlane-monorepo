/**
 * Rebalancer Simulation Harness
 *
 * A simulation environment for testing any rebalancer implementation against
 * realistic warp route traffic. The harness is agnostic to how the rebalancer
 * is implemented - it just provides an environment and measures outcomes.
 *
 * ## Two Approaches
 *
 * ### 1. SimulationEnvironment (Recommended for custom rebalancers)
 *
 * Use this when you have a rebalancer with its own architecture/abstractions.
 * Your rebalancer interacts with the environment by observing state, subscribing
 * to events, and executing rebalances.
 *
 * @example
 * ```typescript
 * import { SimulationEnvironment, ChaosTrafficGenerator, BRIDGE_PRESETS } from './simulation';
 *
 * // Create your custom rebalancer controller
 * const myRebalancer = {
 *   onStart(env) {
 *     // Subscribe to events
 *     env.on((event) => {
 *       if (event.type === 'transfer_waiting') {
 *         // React to transfers waiting for collateral
 *         const state = env.getState();
 *         // ... your logic to decide if/how to rebalance
 *       }
 *     });
 *   },
 *
 *   onTick(env, deltaMs) {
 *     // Or use polling-based approach
 *     const state = env.getState();
 *     for (const waiting of state.waitingTransfers) {
 *       // Find surplus chain and rebalance
 *       env.executeRebalance({
 *         origin: 'ethereum',
 *         destination: waiting.destination,
 *         amount: waiting.amount,
 *       });
 *     }
 *   },
 * };
 *
 * const env = new SimulationEnvironment(config);
 * const results = await env.run(trafficSource, myRebalancer, durationMs);
 * ```
 *
 * ### 2. SimulationEngine (For ISimulationStrategy implementations)
 *
 * Use this for backward compatibility or if your rebalancer already implements
 * the `getRebalancingRoutes(balances, inflight)` interface.
 *
 * @example
 * ```typescript
 * import { SimulationEngine, ChaosTrafficGenerator, NoOpStrategy } from './simulation';
 *
 * const engine = new SimulationEngine(config);
 * const results = await engine.run({
 *   trafficSource: traffic,
 *   rebalancer: new MyStrategy(),  // implements ISimulationStrategy
 *   durationMs: 60 * 60 * 1000,
 *   tickIntervalMs: 1000,
 *   rebalancerIntervalMs: 10_000,
 * });
 * ```
 *
 * ## What the Simulation Measures
 *
 * - **Availability**: % of transfers completed without waiting for collateral
 * - **Latency**: How long transfers take (p50, p95, p99)
 * - **Cost**: Total USD spent on bridge fees
 * - **Overall Score**: Weighted composite of above metrics
 */

// Types
export type {
  AmountDistribution,
  BridgeConfig,
  ChaosConfig,
  InflightContext,
  ISimulationStrategy,
  LatencyDistribution,
  LatencyStats,
  PendingRebalance,
  PendingTransfer,
  RebalancingMetrics,
  RebalancingRoute,
  SimulationConfig,
  SimulationResults,
  SimulationRunOptions,
  SimulationScores,
  SimulationState,
  TimePattern,
  TimeSeriesPoint,
  TrafficSource,
  Transfer,
  TransferMetrics,
  TransferStatus,
} from './types.js';

export { BRIDGE_PRESETS } from './types.js';

// Core components
export { BridgeSimulator, SeededRandom } from './BridgeSimulator.js';
export { ChaosTrafficGenerator } from './ChaosTrafficGenerator.js';
export {
  HistoricalExplorerClient,
  HistoricalTrafficReplay,
  parseTokenMessageAmount,
  parseTokenMessageRecipient,
  StaticTrafficSource,
} from './HistoricalTrafficReplay.js';
export { MetricsCollector } from './MetricsCollector.js';
export { SimulationEngine } from './SimulationEngine.js';
export {
  SimulationEnvironment,
  strategyToController,
} from './SimulationEnvironment.js';

// Strategy adapters (for backward compatibility with ISimulationStrategy)
export {
  createSimulationStrategy,
  createStrategy,
  FunctionStrategy,
  NoOpStrategy,
  RealStrategyAdapter,
  SimpleThresholdStrategy,
} from './StrategyAdapter.js';

export type { RebalancerFunction } from './StrategyAdapter.js';

export type {
  ExplorerMessage,
  HistoricalReplayConfig,
} from './HistoricalTrafficReplay.js';

export type {
  EnvironmentState,
  EventHandler,
  IRebalancerController,
  RebalanceRequest,
  RebalanceResult,
  SimulationEvent,
  SimulationEventType,
  SimulationEnvironmentConfig,
} from './SimulationEnvironment.js';
