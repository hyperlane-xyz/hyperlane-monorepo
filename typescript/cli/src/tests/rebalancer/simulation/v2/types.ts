/**
 * Types for Simulation Harness v2
 */
import type { Address } from '@hyperlane-xyz/utils';

// ============================================================================
// Simulation Run Configuration
// ============================================================================

/**
 * A scheduled transfer in the simulation.
 */
export interface ScheduledTransfer {
  /** Simulation time when transfer should be executed (ms from start) */
  time: number;
  /** Origin chain name */
  origin: string;
  /** Destination chain name */
  destination: string;
  /** Amount in token units (wei) */
  amount: bigint;
  /** Optional: sender address (defaults to test account) */
  sender?: Address;
}

/**
 * A simulation run definition.
 * Can be loaded from YAML/JSON files.
 */
export interface SimulationRun {
  /** Name of this simulation run */
  name: string;
  /** Total duration of simulation in ms */
  durationMs: number;
  /** Scheduled transfers */
  transfers: ScheduledTransfer[];
  /** Optional: override initial balances (chain -> amount in wei) */
  initialBalances?: Record<string, bigint>;
}

/**
 * Parsed simulation run from file (amounts as strings for JSON/YAML compat).
 */
export interface SimulationRunFile {
  name: string;
  durationMs: number;
  transfers: Array<{
    time: number;
    origin: string;
    destination: string;
    amount: string;
  }>;
  initialBalances?: Record<string, string>;
}

// ============================================================================
// Bridge Configuration
// ============================================================================

/**
 * Configuration for a simulated bridge.
 */
export interface SimulatedBridgeConfig {
  /** Fixed fee in token units */
  fixedFee: bigint;
  /** Variable fee in basis points (e.g., 10 = 0.1%) */
  variableFeeBps: number;
  /** Simulated transfer time in ms */
  transferTimeMs: number;
  /** Failure probability (0-1) */
  failureRate?: number;
}

/**
 * Default bridge configs for common bridge types.
 */
export const BRIDGE_CONFIGS = {
  /** CCTP Fast - ~2 minutes */
  cctpFast: {
    fixedFee: 0n,
    variableFeeBps: 0,
    transferTimeMs: 2 * 60 * 1000, // 2 minutes
    failureRate: 0.001,
  } satisfies SimulatedBridgeConfig,

  /** CCTP Slow - ~20-30 minutes */
  cctpSlow: {
    fixedFee: 0n,
    variableFeeBps: 0,
    transferTimeMs: 25 * 60 * 1000, // 25 minutes
    failureRate: 0.001,
  } satisfies SimulatedBridgeConfig,

  /** Fast bridge (e.g., Across) */
  fast: {
    fixedFee: 0n,
    variableFeeBps: 5, // 0.05%
    transferTimeMs: 30 * 1000, // 30 seconds
    failureRate: 0.005,
  } satisfies SimulatedBridgeConfig,
};

// ============================================================================
// Pending Items
// ============================================================================

/**
 * A pending warp route transfer.
 */
export interface PendingWarpTransfer {
  /** Hyperlane message ID */
  messageId: string;
  /** Transaction hash */
  txHash: string;
  /** Origin chain name */
  origin: string;
  /** Destination chain name */
  destination: string;
  /** Amount transferred */
  amount: bigint;
  /** Sender address */
  sender: Address;
  /** Recipient address */
  recipient: Address;
  /** Simulation time when transfer was initiated */
  initiatedAt: number;
  /** Simulation time when transfer should complete (message delivered) */
  expectedCompletionAt: number;
  /** Whether the transfer has been completed */
  completed: boolean;
  /** The actual message bytes from the Dispatch event (for delivery) */
  messageBytes?: string;
}

/**
 * A pending bridge transfer (rebalancing).
 */
export interface PendingBridgeTransfer {
  /** Bridge transfer ID */
  transferId: string;
  /** Origin chain name */
  origin: string;
  /** Destination chain name */
  destination: string;
  /** Amount being transferred */
  amount: bigint;
  /** Fee paid */
  fee: bigint;
  /** Bridge contract address */
  bridge: Address;
  /** Simulation time when transfer was initiated */
  initiatedAt: number;
  /** Simulation time when transfer should complete */
  expectedCompletionAt: number;
  /** Whether the transfer has been completed */
  completed: boolean;
}

// ============================================================================
// Metrics
// ============================================================================

/**
 * Metrics for a single completed transfer.
 */
export interface TransferMetric {
  /** Transfer ID (message ID) */
  id: string;
  /** Origin chain */
  origin: string;
  /** Destination chain */
  destination: string;
  /** Amount transferred */
  amount: bigint;
  /** When transfer was initiated (simulation time) */
  initiatedAt: number;
  /** When transfer completed (simulation time) */
  completedAt: number;
  /** Total latency in ms */
  latencyMs: number;
  /** Whether transfer had to wait for collateral */
  waitedForCollateral: boolean;
  /** Time spent waiting for collateral (if any) */
  collateralWaitMs: number;
}

/**
 * Metrics for a bridge rebalance.
 */
export interface BridgeMetric {
  /** Origin chain */
  origin: string;
  /** Destination chain */
  destination: string;
  /** Amount transferred */
  amount: bigint;
  /** Fee paid in token units */
  fee: bigint;
  /** Fee in USD (if calculable) */
  feeUsd?: number;
  /** Bridge type/address */
  bridge: string;
  /** When rebalance was initiated */
  initiatedAt: number;
  /** When rebalance completed */
  completedAt: number;
}

/**
 * Time series data point.
 */
export interface TimeSeriesPoint {
  /** Simulation time */
  time: number;
  /** Collateral balances by chain */
  balances: Record<string, bigint>;
  /** Number of pending warp transfers */
  pendingTransfers: number;
  /** Number of pending bridge transfers */
  pendingBridges: number;
  /** Number of transfers waiting for collateral */
  waitingForCollateral: number;
}

/**
 * Latency statistics.
 */
export interface LatencyStats {
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
}

/**
 * Transfer event for timeline visualization.
 */
export interface TransferEvent {
  /** Simulation time */
  time: number;
  /** Event type */
  type: 'transfer_initiated' | 'transfer_completed' | 'rebalance_initiated' | 'rebalance_completed';
  /** Origin chain */
  origin: string;
  /** Destination chain */
  destination: string;
  /** Amount */
  amount: bigint;
}

/**
 * Enhanced time series data point with traffic info.
 */
export interface EnhancedTimeSeriesPoint extends TimeSeriesPoint {
  /** Transfer events at this time point */
  events: TransferEvent[];
  /** Rebalancer proposed routes (if any) */
  proposedRoutes: Array<{ origin: string; destination: string; amount: bigint }>;
}

/**
 * Final simulation results.
 */
export interface SimulationResults {
  /** Simulation run name */
  name: string;

  /** Duration stats */
  duration: {
    /** Simulated time in ms */
    simulatedMs: number;
    /** Wall clock time in ms */
    wallClockMs: number;
  };

  /** Transfer metrics */
  transfers: {
    /** Total transfers executed */
    total: number;
    /** Transfers completed successfully */
    completed: number;
    /** Transfers that timed out */
    stuck: number;
    /** Latency statistics */
    latency: LatencyStats;
    /** Collateral wait statistics */
    collateralWait: {
      /** Transfers that had to wait */
      count: number;
      /** Percentage of transfers that waited */
      percent: number;
      /** Average wait time for affected transfers */
      meanMs: number;
    };
  };

  /** Rebalancing metrics */
  rebalancing: {
    /** Total rebalances executed */
    count: number;
    /** Total volume rebalanced */
    totalVolume: bigint;
    /** Total fees paid */
    totalFees: bigint;
    /** Total fees in USD */
    totalFeesUsd: number;
    /** Breakdown by bridge type */
    byBridge: Record<string, {
      count: number;
      volume: bigint;
      fees: bigint;
    }>;
  };

  /** Time series data for visualization */
  timeSeries: TimeSeriesPoint[];
  
  /** Enhanced time series with events (for detailed visualization) */
  enhancedTimeSeries?: EnhancedTimeSeriesPoint[];
}

// ============================================================================
// Traffic Patterns
// ============================================================================

/**
 * Traffic pattern configuration.
 */
export interface TrafficPattern {
  /** Pattern name */
  name: string;
  /** Generate transfers for this pattern */
  generate(config: TrafficPatternConfig): ScheduledTransfer[];
}

/**
 * Configuration for traffic pattern generation.
 */
export interface TrafficPatternConfig {
  /** Duration of simulation in ms */
  durationMs: number;
  /** Available chain names */
  chains: string[];
  /** Collateral chains (subset of chains) */
  collateralChains: string[];
  /** Synthetic chains (subset of chains) */
  syntheticChains: string[];
  /** Base transfer amount in wei */
  baseAmount: bigint;
  /** Random seed for reproducibility */
  seed?: number;
}
