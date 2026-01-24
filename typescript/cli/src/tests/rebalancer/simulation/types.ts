/**
 * Rebalancer Simulation Types
 *
 * Core types for the chaos/backtest simulation harness.
 */
import type { Address } from '@hyperlane-xyz/utils';

// ============================================================================
// Transfer Types
// ============================================================================

export interface Transfer {
  id: string;
  timestamp: number; // ms since simulation start
  origin: string; // chain name
  destination: string; // chain name
  amount: bigint;
  sender: Address;
  recipient: Address;
}

export type TransferStatus =
  | 'in_flight' // warp transfer in progress
  | 'waiting_collateral' // arrived but no collateral
  | 'completed' // successfully completed
  | 'stuck'; // timed out waiting for collateral

export interface PendingTransfer {
  transfer: Transfer;
  arrivalTime: number; // when it needs collateral
  status: TransferStatus;
  collateralAvailableAt?: number; // when collateral became available
  completedAt?: number;
}

// ============================================================================
// Rebalancing Types
// ============================================================================

export interface RebalancingRoute {
  origin: string;
  destination: string;
  amount: bigint;
  bridge?: Address;
}

export type RebalanceStatus = 'in_flight' | 'completed' | 'failed';

export interface PendingRebalance {
  route: RebalancingRoute;
  initiatedAt: number;
  expectedArrivalAt: number;
  status: RebalanceStatus;
  cost: {
    gas: bigint;
    usd: number;
  };
}

// ============================================================================
// Bridge Configuration
// ============================================================================

export type LatencyDistribution = 'uniform' | 'normal' | 'exponential';

export interface BridgeConfig {
  // Cost model
  fixedCostUsd: number; // flat fee per tx
  variableCostBps: number; // basis points of amount
  gasEstimate: bigint; // gas units

  // Latency model
  minLatencyMs: number;
  maxLatencyMs: number;
  latencyDistribution: LatencyDistribution;

  // Reliability
  failureRate: number; // 0-1, probability of failure
}

/**
 * Preset bridge configurations for common bridge types.
 */
export const BRIDGE_PRESETS: Record<string, BridgeConfig> = {
  // Fast bridge (e.g., Across, Stargate)
  fast: {
    fixedCostUsd: 0.3,
    variableCostBps: 4,
    gasEstimate: 150_000n,
    minLatencyMs: 15_000, // 15s
    maxLatencyMs: 90_000, // 90s
    latencyDistribution: 'normal',
    failureRate: 0.005,
  },

  // Medium bridge
  medium: {
    fixedCostUsd: 0.15,
    variableCostBps: 2,
    gasEstimate: 120_000n,
    minLatencyMs: 120_000, // 2 min
    maxLatencyMs: 600_000, // 10 min
    latencyDistribution: 'normal',
    failureRate: 0.002,
  },

  // Slow/cheap bridge (e.g., canonical)
  slow: {
    fixedCostUsd: 0.1,
    variableCostBps: 1,
    gasEstimate: 100_000n,
    minLatencyMs: 600_000, // 10 min
    maxLatencyMs: 1_800_000, // 30 min
    latencyDistribution: 'uniform',
    failureRate: 0.001,
  },

  // Warp route as bridge
  warp: {
    fixedCostUsd: 0.05,
    variableCostBps: 0,
    gasEstimate: 200_000n,
    minLatencyMs: 60_000, // 1 min
    maxLatencyMs: 300_000, // 5 min
    latencyDistribution: 'normal',
    failureRate: 0.001,
  },
};

// ============================================================================
// Traffic Source
// ============================================================================

export interface TrafficSource {
  /**
   * Get transfers in a time window.
   */
  getTransfers(startTime: number, endTime: number): Transfer[];

  /**
   * Total number of transfers in the source.
   */
  getTotalTransferCount(): number;

  /**
   * Time range covered by this source.
   */
  getTimeRange(): { start: number; end: number };
}

// ============================================================================
// Simulation Configuration
// ============================================================================

export interface SimulationConfig {
  // Initial state
  initialBalances: Record<string, bigint>; // chain -> balance

  // Bridge configs: "origin-destination" -> config
  bridges: Record<string, BridgeConfig>;

  // Warp route timing
  warpTransferLatencyMs: number; // time for HypERC20 transfer

  // Cost calculation
  gasPrices: Record<string, bigint>; // chain -> gas price in wei
  ethPriceUsd: number;
  tokenPriceUsd?: number; // price of the token being transferred (default 1 for stablecoins)

  // Timeout for stuck transfers
  transferTimeoutMs: number; // how long before marking as stuck
}

export interface SimulationRunOptions {
  trafficSource: TrafficSource;

  // The rebalancer strategy to test (black box)
  rebalancer: ISimulationStrategy;

  // Timing
  durationMs: number;
  tickIntervalMs: number; // simulation resolution
  rebalancerIntervalMs: number; // how often rebalancer evaluates
}

// ============================================================================
// Rebalancer Interface (Black Box)
// ============================================================================

export interface InflightContext {
  pendingRebalances: RebalancingRoute[];
  pendingTransfers: RebalancingRoute[];
}

/**
 * Interface for rebalancer strategies in simulation.
 * This is intentionally minimal - we treat the rebalancer as a black box.
 */
export interface ISimulationStrategy {
  /**
   * Get rebalancing routes given current balances and inflight context.
   */
  getRebalancingRoutes(
    balances: Record<string, bigint>,
    inflight: InflightContext,
  ): RebalancingRoute[];
}

// ============================================================================
// Simulation State
// ============================================================================

export interface SimulationState {
  currentTime: number;
  collateralBalances: Record<string, bigint>;
  pendingTransfers: PendingTransfer[];
  pendingRebalances: PendingRebalance[];
}

// ============================================================================
// Metrics & Results
// ============================================================================

export interface LatencyStats {
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface TransferMetrics {
  total: number;
  completed: number;
  stuck: number;

  latency: LatencyStats;

  collateralWaitTime: {
    mean: number;
    p95: number;
    affectedCount: number;
    affectedPercent: number;
  };
}

export interface RebalancingMetrics {
  initiated: number;
  completed: number;
  failed: number;

  volume: {
    total: bigint;
    perTransfer: bigint;
  };

  cost: {
    totalGas: bigint;
    totalUsd: number;
    perTransferUsd: number;
  };
}

export interface TimeSeriesPoint {
  timestamp: number;
  balances: Record<string, bigint>;
  pendingTransfers: number;
  waitingTransfers: number;
  pendingRebalances: number;
}

export interface SimulationScores {
  // All scores 0-100, higher is better
  availability: number; // % transfers completed without waiting
  latency: number; // inverse of p95 latency, normalized
  costEfficiency: number; // transfers per dollar spent
  overall: number; // weighted composite
}

export interface SimulationResults {
  // Summary
  duration: {
    simulatedMs: number;
    wallClockMs: number;
  };

  // Detailed metrics
  transfers: TransferMetrics;
  rebalancing: RebalancingMetrics;

  // Time series for visualization
  timeSeries: TimeSeriesPoint[];

  // Final scores
  scores: SimulationScores;
}

// ============================================================================
// Chaos Traffic Generator Config
// ============================================================================

export type AmountDistribution = 'uniform' | 'pareto' | 'bimodal';
export type TimePattern = 'constant' | 'daily_cycle' | 'weekly_cycle';

export interface ChaosConfig {
  // Chains
  chains: string[];
  collateralChains: string[]; // subset that hold collateral

  // Volume
  transfersPerMinute: number;
  burstProbability?: number; // chance of 10x burst

  // Amounts
  amountDistribution: {
    min: bigint;
    max: bigint;
    distribution: AmountDistribution;
  };

  // Direction weights (optional)
  // e.g., { ethereum: { arbitrum: 0.6, optimism: 0.4 } }
  directionWeights?: Record<string, Record<string, number>>;

  // Time patterns
  timePattern?: TimePattern;

  // Random seed for reproducibility
  seed?: number;
}
