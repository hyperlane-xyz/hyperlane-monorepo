/**
 * Rebalancer Simulation Harness
 *
 * A behavioral test harness for the Hyperlane rebalancer that:
 * - Generates chaos traffic or replays historical data
 * - Runs rebalancer strategies as a black box
 * - Measures outcomes (latency, cost, availability)
 * - Enables strategy comparison
 *
 * @example
 * ```typescript
 * import {
 *   SimulationEngine,
 *   ChaosTrafficGenerator,
 *   NoOpStrategy,
 *   SimpleThresholdStrategy,
 *   BRIDGE_PRESETS,
 * } from './simulation/index.js';
 *
 * // Create traffic
 * const traffic = new ChaosTrafficGenerator({
 *   chains: ['ethereum', 'arbitrum', 'optimism'],
 *   collateralChains: ['ethereum', 'arbitrum', 'optimism'],
 *   transfersPerMinute: 10,
 *   amountDistribution: {
 *     min: toWei('100'),
 *     max: toWei('10000'),
 *     distribution: 'pareto',
 *   },
 * }, 60 * 60 * 1000); // 1 hour
 *
 * // Create engine
 * const engine = new SimulationEngine({
 *   initialBalances: {
 *     ethereum: toWei('1000000'),
 *     arbitrum: toWei('500000'),
 *     optimism: toWei('500000'),
 *   },
 *   bridges: {
 *     'ethereum-arbitrum': BRIDGE_PRESETS.fast,
 *     'ethereum-optimism': BRIDGE_PRESETS.fast,
 *     'arbitrum-optimism': BRIDGE_PRESETS.fast,
 *     'arbitrum-ethereum': BRIDGE_PRESETS.fast,
 *     'optimism-ethereum': BRIDGE_PRESETS.fast,
 *     'optimism-arbitrum': BRIDGE_PRESETS.fast,
 *   },
 *   warpTransferLatencyMs: 60_000,
 *   gasPrices: {
 *     ethereum: 30_000_000_000n,
 *     arbitrum: 100_000_000n,
 *     optimism: 100_000_000n,
 *   },
 *   ethPriceUsd: 2000,
 *   transferTimeoutMs: 10 * 60 * 1000, // 10 min
 * });
 *
 * // Run simulation
 * const results = await engine.run({
 *   trafficSource: traffic,
 *   rebalancer: new SimpleThresholdStrategy(...),
 *   durationMs: 60 * 60 * 1000,
 *   tickIntervalMs: 1000,
 *   rebalancerIntervalMs: 10_000,
 * });
 *
 * console.log('Scores:', results.scores);
 * ```
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
export { MetricsCollector } from './MetricsCollector.js';
export { SimulationEngine } from './SimulationEngine.js';

// Strategy adapters
export {
  createSimulationStrategy,
  NoOpStrategy,
  RealStrategyAdapter,
  SimpleThresholdStrategy,
} from './StrategyAdapter.js';
