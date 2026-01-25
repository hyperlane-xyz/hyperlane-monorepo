/**
 * Rebalancer Test Harness
 *
 * This module provides utilities for testing the Hyperlane rebalancer
 * on a single anvil instance with multiple simulated domains.
 *
 * Key features:
 * - Single anvil, multiple domain IDs (fast setup)
 * - TestISM for easy message relay
 * - Phase-based testing for crash resilience
 * - Snapshot/restore for test isolation
 *
 * @example
 * ```typescript
 * import {
 *   createRebalancerTestSetup,
 *   DOMAIN_1,
 *   DOMAIN_2,
 *   DOMAIN_3,
 *   transferAndRelay,
 *   writeWeightedConfig,
 *   Phase,
 *   createPhaseRunner,
 * } from './harness/index.js';
 *
 * // Setup with 2 collateral domains and 1 synthetic
 * const setup = await createRebalancerTestSetup({
 *   collateralDomains: [DOMAIN_1, DOMAIN_2],
 *   syntheticDomains: [DOMAIN_3],
 *   initialCollateral: toWei(10),
 * });
 *
 * // Create imbalance
 * await transferAndRelay(setup, 'domain1', 'domain3', toWei(8));
 *
 * // Write rebalancer config
 * writeWeightedConfig({
 *   setup,
 *   chains: {
 *     domain1: { weight: 50, bridge: setup.getBridge('domain1', 'domain2') },
 *     domain2: { weight: 50, bridge: setup.getBridge('domain2', 'domain1') },
 *   },
 * });
 *
 * // Phase-based testing
 * const runner = createPhaseRunner(setup);
 * await runner.runWithPhases({
 *   phases: [Phase.INITIAL, Phase.POST_IMBALANCE, Phase.ROUTES_COMPUTED],
 *   onPhase: async (context) => {
 *     console.log(`Phase: ${context.phase}, Balances:`, context.balances);
 *   },
 * });
 * ```
 */

// Setup utilities
export {
  ANVIL_ADDRESSES,
  ANVIL_DEPLOYER_ADDRESS,
  ANVIL_KEY,
  ANVIL_KEYS,
  type AnvilInstance,
  createRebalancerTestSetup,
  type CreateRebalancerTestSetupOptions,
  DOMAIN_1,
  DOMAIN_2,
  DOMAIN_3,
  DOMAIN_4,
  type DomainConfig,
  type DomainDeployment,
  type RebalancerTestSetup,
  type SimulatedBridgeOptions,
  type SnapshotInfo,
  startAnvil,
} from './setup.js';

// Transfer utilities
export {
  depositCollateral,
  getAllWarpRouteBalances,
  getWarpRouteBalance,
  transferAndRelay,
  type TransferResult,
  withdrawCollateral,
} from './transfer.js';

// Config utilities
export {
  createEqualWeightedConfig,
  createMinAmountConfig,
  DEFAULT_REBALANCER_CONFIG_PATH,
  type MinAmountChainConfig,
  type WeightedChainConfig,
  writeMinAmountConfig,
  writeWeightedConfig,
  type WriteMinAmountConfigOptions,
  type WriteWeightedConfigOptions,
} from './config.js';

// Phase-based testing
export {
  captureStateAt,
  createPhaseRunner,
  Phase,
  type PhaseContext,
  type PhaseHandler,
  type PhaseRunnerOptions,
  type PhaseRunResult,
  simulateCrashAt,
} from './phases.js';

// Mock explorer for inflight message tracking
export {
  createMockMessageFromDispatch,
  type MockMessage,
  MockExplorerServer,
  // Backward compatibility exports
  createInflightMessage,
  type InflightMessage,
} from './mock-explorer.js';
