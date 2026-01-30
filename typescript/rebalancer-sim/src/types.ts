/**
 * Consolidated types for rebalancer-sim
 *
 * This file contains all type definitions for the simulation framework,
 * organized by domain.
 */
import type { WarpCoreConfig } from '@hyperlane-xyz/sdk';
import type { Address } from '@hyperlane-xyz/utils';

// =============================================================================
// BRIDGE TYPES
// =============================================================================

/**
 * Bridge mock configuration for REBALANCER transfers.
 *
 * This configures the simulated bridge delays for when the rebalancer moves
 * funds between chains. In production, these bridges (CCTP, etc.) can have
 * delays ranging from ~10 seconds to 7 days depending on the bridge type.
 *
 * NOTE: This is separate from user transfer delivery, which goes through
 * Hyperlane/Mailbox and is configured via SimulationTiming.userTransferDeliveryDelay.
 */
export interface BridgeMockConfig {
  [origin: string]: {
    [dest: string]: BridgeRouteConfig;
  };
}

/**
 * Configuration for a single bridge route
 */
export interface BridgeRouteConfig {
  /** Delivery delay in milliseconds (e.g., 500ms for fast simulation) */
  deliveryDelay: number;
  /** Failure rate as decimal 0-1 (e.g., 0.01 for 1%) */
  failureRate: number;
  /** Jitter in milliseconds (± variance) */
  deliveryJitter: number;
  /** Optional native fee for bridge */
  nativeFee?: bigint;
  /** Optional token fee as basis points (e.g., 10 = 0.1%) */
  tokenFeeBps?: number;
}

/**
 * Pending transfer in bridge controller
 */
export interface PendingTransfer {
  id: string;
  origin: string;
  destination: string;
  amount: bigint;
  recipient: Address;
  scheduledDelivery: number;
  failed: boolean;
  delivered: boolean;
  deliveredAt?: number;
}

/**
 * Bridge event types
 */
export type BridgeEventType =
  | 'transfer_initiated'
  | 'transfer_delivered'
  | 'transfer_failed';

/**
 * Bridge event for tracking
 */
export interface BridgeEvent {
  type: BridgeEventType;
  transfer: PendingTransfer;
  timestamp: number;
}

/**
 * Default bridge config for testing
 */
export const DEFAULT_BRIDGE_ROUTE_CONFIG: BridgeRouteConfig = {
  deliveryDelay: 500,
  failureRate: 0,
  deliveryJitter: 100,
};

/**
 * Creates a symmetric bridge config for all chain pairs
 */
export function createSymmetricBridgeConfig(
  chains: string[],
  config: BridgeRouteConfig = DEFAULT_BRIDGE_ROUTE_CONFIG,
): BridgeMockConfig {
  const bridgeConfig: BridgeMockConfig = {};

  for (const origin of chains) {
    bridgeConfig[origin] = {};
    for (const dest of chains) {
      if (origin !== dest) {
        bridgeConfig[origin][dest] = { ...config };
      }
    }
  }

  return bridgeConfig;
}

// =============================================================================
// DEPLOYMENT TYPES
// =============================================================================

/**
 * Configuration for a simulated chain domain
 */
export interface SimulatedChainConfig {
  chainName: string;
  domainId: number;
}

/**
 * Deployed addresses for a single domain
 */
export interface DeployedDomain {
  chainName: string;
  domainId: number;
  mailbox: Address;
  warpToken: Address;
  collateralToken: Address;
  bridge: Address;
}

/**
 * Complete multi-domain deployment result
 */
export interface MultiDomainDeploymentResult {
  anvilRpc: string;
  deployer: Address;
  deployerKey: string;
  /** Separate key for rebalancer (different nonce) */
  rebalancerKey: string;
  rebalancer: Address;
  /** Separate key for bridge controller (different nonce) */
  bridgeControllerKey: string;
  bridgeController: Address;
  /** Separate key for mailbox processor (different nonce) */
  mailboxProcessorKey: string;
  mailboxProcessor: Address;
  domains: Record<string, DeployedDomain>;
}

/**
 * Options for multi-domain deployment
 */
export interface MultiDomainDeploymentOptions {
  /** RPC URL for anvil instance */
  anvilRpc: string;
  /** Deployer private key */
  deployerKey: string;
  /** Rebalancer private key (separate nonce from deployer) */
  rebalancerKey?: string;
  /** Bridge controller private key (separate nonce from deployer and rebalancer) */
  bridgeControllerKey?: string;
  /** Mailbox processor private key (separate nonce for processing mailbox messages) */
  mailboxProcessorKey?: string;
  /** Chain configurations to deploy */
  chains: SimulatedChainConfig[];
  /** Initial collateral balance per chain (in wei) */
  initialCollateralBalance: bigint;
  /** Token decimals */
  tokenDecimals?: number;
  /** Token symbol */
  tokenSymbol?: string;
  /** Token name */
  tokenName?: string;
}

/**
 * Default simulated chains for testing
 */
export const DEFAULT_SIMULATED_CHAINS: SimulatedChainConfig[] = [
  { chainName: 'chain1', domainId: 1000 },
  { chainName: 'chain2', domainId: 2000 },
  { chainName: 'chain3', domainId: 3000 },
];

/**
 * Default anvil deployer key (first account)
 */
export const ANVIL_DEPLOYER_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

/**
 * Default anvil deployer address
 */
export const ANVIL_DEPLOYER_ADDRESS =
  '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

/**
 * Second anvil account key (for rebalancer - separate nonce)
 */
export const ANVIL_REBALANCER_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

/**
 * Second anvil account address
 */
export const ANVIL_REBALANCER_ADDRESS =
  '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

/**
 * Third anvil account key (for bridge controller - separate nonce)
 */
export const ANVIL_BRIDGE_CONTROLLER_KEY =
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';

/**
 * Third anvil account address
 */
export const ANVIL_BRIDGE_CONTROLLER_ADDRESS =
  '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

/**
 * Fourth anvil account key (for mailbox processor - separate nonce)
 */
export const ANVIL_MAILBOX_PROCESSOR_KEY =
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6';

/**
 * Fourth anvil account address
 */
export const ANVIL_MAILBOX_PROCESSOR_ADDRESS =
  '0x90F79bf6EB2c4f870365E785982E1f101E93b906';

// =============================================================================
// KPI TYPES
// =============================================================================

/**
 * Per-chain metrics
 */
export interface ChainMetrics {
  chainName: string;
  initialBalance: bigint;
  finalBalance: bigint;
  transfersIn: number;
  transfersOut: number;
  rebalancesIn: number;
  rebalancesOut: number;
  rebalanceVolumeIn: bigint;
  rebalanceVolumeOut: bigint;
}

/**
 * KPIs collected during simulation
 */
export interface SimulationKPIs {
  totalTransfers: number;
  completedTransfers: number;
  failedTransfers: number;
  completionRate: number;
  averageLatency: number;
  p50Latency: number;
  p95Latency: number;
  p99Latency: number;
  totalRebalances: number;
  rebalanceVolume: bigint;
  totalGasCost: bigint;
  perChainMetrics: Record<string, ChainMetrics>;
}

/**
 * State snapshot at a point in time
 */
export interface StateSnapshot {
  timestamp: number;
  balances: Record<string, bigint>;
  pendingTransfers: number;
  pendingRebalances: number;
}

/**
 * Transfer tracking record
 */
export interface TransferRecord {
  id: string;
  origin: string;
  destination: string;
  amount: bigint;
  startTime: number;
  endTime?: number;
  latency?: number;
  status: 'pending' | 'completed' | 'failed';
}

/**
 * Rebalance tracking record
 */
export interface RebalanceRecord {
  id: string;
  /** Bridge transfer ID for correlation */
  bridgeTransferId?: string;
  origin: string;
  destination: string;
  amount: bigint;
  startTime: number;
  endTime?: number;
  latency?: number;
  gasCost: bigint;
  status: 'pending' | 'completed' | 'failed';
}

/**
 * Complete simulation result
 */
export interface SimulationResult {
  scenarioName: string;
  rebalancerName: string;
  startTime: number;
  endTime: number;
  duration: number;
  kpis: SimulationKPIs;
  transferRecords: TransferRecord[];
  rebalanceRecords: RebalanceRecord[];
}

/**
 * Comparison report for multiple rebalancers
 */
export interface ComparisonReport {
  scenarioName: string;
  results: SimulationResult[];
  comparison: {
    bestCompletionRate: string;
    bestLatency: string;
    lowestGasCost: string;
  };
}

// =============================================================================
// REBALANCER TYPES
// =============================================================================

/**
 * Rebalancer configuration for simulation
 */
export interface RebalancerSimConfig {
  /** Polling frequency in milliseconds */
  pollingFrequency: number;
  /** Warp core configuration */
  warpConfig: WarpCoreConfig;
  /** Strategy-specific configuration */
  strategyConfig: RebalancerStrategyConfig;
  /** Deployment info */
  deployment: MultiDomainDeploymentResult;
}

/**
 * Strategy configuration for rebalancer
 */
export interface RebalancerStrategyConfig {
  type: 'weighted' | 'minAmount';
  chains: Record<string, ChainStrategyConfig>;
}

/**
 * Per-chain strategy configuration
 */
export interface ChainStrategyConfig {
  weighted?: {
    weight: string;
    tolerance: string;
  };
  minAmount?: {
    min: string;
    target: string;
    type: 'absolute' | 'relative';
  };
  bridge: string;
  bridgeLockTime: number;
}

/**
 * Interface for rebalancer runners in simulation
 */
export interface IRebalancerRunner {
  /** Name of the rebalancer implementation */
  readonly name: string;

  /**
   * Initialize the rebalancer with configuration
   */
  initialize(config: RebalancerSimConfig): Promise<void>;

  /**
   * Start the rebalancer daemon
   */
  start(): Promise<void>;

  /**
   * Stop the rebalancer daemon
   */
  stop(): Promise<void>;

  /**
   * Check if the rebalancer is currently active (has pending operations)
   */
  isActive(): boolean;

  /**
   * Wait for the rebalancer to complete current operations
   */
  waitForIdle(timeoutMs?: number): Promise<void>;

  /**
   * Subscribe to rebalancer events
   */
  on(event: 'rebalance', listener: (e: RebalancerEvent) => void): this;
}

/**
 * Event emitted when rebalancer performs an action
 */
export interface RebalancerEvent {
  type:
    | 'rebalance_initiated'
    | 'rebalance_completed'
    | 'rebalance_failed'
    | 'cycle_completed';
  timestamp: number;
  origin?: string;
  destination?: string;
  amount?: bigint;
  error?: string;
}

// =============================================================================
// SCENARIO TYPES
// =============================================================================

/**
 * Complete scenario file format - includes metadata, transfers, and default configs
 */
export interface ScenarioFile {
  /** Scenario name for identification */
  name: string;

  /** Human-readable description of what this scenario tests */
  description: string;

  /** Explanation of expected behavior and why */
  expectedBehavior: string;

  /** Total simulated duration in milliseconds */
  duration: number;

  /** Chain names involved in this scenario */
  chains: string[];

  /** Optional extra tokens to mint per chain after deployment (for creating imbalanced initial state) */
  initialImbalance?: Record<string, string>;

  /** Ordered list of transfer events */
  transfers: SerializedTransferEvent[];

  /** Default initial collateral balance per chain in wei (as string for JSON) */
  defaultInitialCollateral: string;

  /** Default timing configuration */
  defaultTiming: SimulationTiming;

  /** Default bridge mock configuration */
  defaultBridgeConfig: SerializedBridgeConfig;

  /** Default rebalancer strategy configuration (without bridge addresses) */
  defaultStrategyConfig: SerializedStrategyConfig;

  /** Expected outcomes for assertions */
  expectations: ScenarioExpectations;
}

/**
 * Timing configuration for simulation execution
 */
export interface SimulationTiming {
  /**
   * Delay for user transfers via Hyperlane/Mailbox (ms).
   * Simulates real Hyperlane finality (~10-15s in production).
   * Set to 0 for instant delivery in fast tests.
   */
  userTransferDeliveryDelay: number;
  /** How often rebalancer polls for imbalances (ms) */
  rebalancerPollingFrequency: number;
  /** Minimum spacing between user transfer executions (ms) */
  userTransferInterval: number;
}

/**
 * Serialized bridge config for JSON storage
 */
export interface SerializedBridgeConfig {
  [origin: string]: {
    [dest: string]: {
      /** Delivery delay in milliseconds */
      deliveryDelay: number;
      /** Failure rate as decimal 0-1 */
      failureRate: number;
      /** Jitter in milliseconds (± variance) */
      deliveryJitter: number;
    };
  };
}

/**
 * Serialized strategy config for JSON storage (bridge addresses added at runtime)
 */
export interface SerializedStrategyConfig {
  type: 'weighted' | 'minAmount';
  chains: {
    [chain: string]: {
      weighted?: {
        /** Weight as decimal string (e.g., "0.333") */
        weight: string;
        /** Tolerance as decimal string (e.g., "0.15" for 15%) */
        tolerance: string;
      };
      minAmount?: {
        /** Minimum balance in tokens (as string) */
        min: string;
        /** Target balance in tokens (as string) */
        target: string;
      };
      /** Time bridge locks funds before delivery (ms) - used for semaphore */
      bridgeLockTime: number;
    };
  };
}

/**
 * Expected outcomes for test assertions
 */
export interface ScenarioExpectations {
  /** Minimum completion rate (0-1), e.g., 0.9 for 90% */
  minCompletionRate?: number;
  /** Minimum number of rebalances expected */
  minRebalances?: number;
  /** Maximum number of rebalances expected */
  maxRebalances?: number;
  /** Whether rebalancing should be triggered at all */
  shouldTriggerRebalancing?: boolean;
}

/**
 * Transfer scenario definition for simulation (runtime format)
 */
export interface TransferScenario {
  /** Scenario name for identification */
  name: string;
  /** Total simulated duration in milliseconds */
  duration: number;
  /** Ordered list of transfer events */
  transfers: TransferEvent[];
  /** Chain names involved in this scenario */
  chains: string[];
}

/**
 * Individual transfer event within a scenario
 */
export interface TransferEvent {
  /** Unique identifier for this transfer */
  id: string;
  /** Timestamp offset from scenario start in milliseconds */
  timestamp: number;
  /** Origin chain name */
  origin: string;
  /** Destination chain name */
  destination: string;
  /** Transfer amount in wei */
  amount: bigint;
  /** User address initiating the transfer */
  user: Address;
}

/**
 * Options for generating unidirectional flow scenarios
 */
export interface UnidirectionalFlowOptions {
  /** Origin chain name */
  origin: string;
  /** Destination chain name */
  destination: string;
  /** Number of transfers */
  transferCount: number;
  /** Total duration in milliseconds */
  duration: number;
  /** Fixed or range of transfer amounts in wei */
  amount: bigint | [bigint, bigint];
  /** User address (optional, will be generated if not provided) */
  user?: Address;
}

/**
 * Options for generating random traffic scenarios
 */
export interface RandomTrafficOptions {
  /** Chain names to use */
  chains: string[];
  /** Number of transfers */
  transferCount: number;
  /** Total duration in milliseconds */
  duration: number;
  /** Range of transfer amounts in wei [min, max] */
  amountRange: [bigint, bigint];
  /** User addresses (optional, will be generated if not provided) */
  users?: Address[];
  /** Distribution type */
  distribution?: 'uniform' | 'poisson';
  /** Mean interval for Poisson distribution in ms */
  poissonMeanInterval?: number;
}

/**
 * Options for generating surge scenarios
 */
export interface SurgeScenarioOptions {
  /** Chain names */
  chains: string[];
  /** Baseline transfers per second */
  baselineRate: number;
  /** Surge multiplier */
  surgeMultiplier: number;
  /** Surge start time (ms from start) */
  surgeStart: number;
  /** Surge duration (ms) */
  surgeDuration: number;
  /** Total duration (ms) */
  totalDuration: number;
  /** Amount range */
  amountRange: [bigint, bigint];
}

/**
 * Serialized transfer event for JSON storage
 */
export interface SerializedTransferEvent {
  id: string;
  timestamp: number;
  origin: string;
  destination: string;
  /** Amount as string for JSON compatibility */
  amount: string;
  user: string;
}

/**
 * Serialized scenario for JSON storage (legacy format, transfers only)
 */
export interface SerializedScenario {
  name: string;
  duration: number;
  chains: string[];
  transfers: SerializedTransferEvent[];
}

// =============================================================================
// VISUALIZER TYPES
// =============================================================================

/**
 * Unified timeline event for visualization
 */
export type TimelineEvent =
  | {
      type: 'transfer_start';
      timestamp: number;
      data: TransferRecord;
    }
  | {
      type: 'transfer_complete';
      timestamp: number;
      data: TransferRecord;
    }
  | {
      type: 'transfer_failed';
      timestamp: number;
      data: TransferRecord;
    }
  | {
      type: 'rebalance_start';
      timestamp: number;
      data: RebalanceRecord;
    }
  | {
      type: 'rebalance_complete';
      timestamp: number;
      data: RebalanceRecord;
    }
  | {
      type: 'rebalance_failed';
      timestamp: number;
      data: RebalanceRecord;
    };

/**
 * Simulation config for display
 */
export interface SimulationConfig {
  /** Scenario name */
  scenarioName?: string;
  /** Scenario description */
  description?: string;
  /** Expected behavior explanation */
  expectedBehavior?: string;
  /** Per-chain target weights (percentage) */
  targetWeights?: Record<string, number>;
  /** Per-chain tolerance (percentage) */
  tolerances?: Record<string, number>;
  /** User transfer delivery delay in ms (Hyperlane finality) */
  userTransferDelay?: number;
  /** Rebalancer bridge delivery delay in ms */
  bridgeDeliveryDelay?: number;
  /** Rebalancer polling frequency in ms */
  rebalancerPollingFrequency?: number;
  /** Initial collateral per chain */
  initialCollateral?: Record<string, string>;
  /** Transfer count */
  transferCount?: number;
  /** Simulation duration in ms */
  duration?: number;
}

/**
 * Processed data ready for visualization
 */
export interface VisualizationData {
  scenario: string;
  rebalancerName: string;
  startTime: number;
  endTime: number;
  duration: number;
  chains: string[];
  events: TimelineEvent[];
  transfers: TransferRecord[];
  rebalances: RebalanceRecord[];
  kpis: SimulationResult['kpis'];
  config?: SimulationConfig;
  /** Balance timeline for rendering balance curves */
  balanceTimeline: Array<{
    timestamp: number;
    balances: Record<string, string>;
  }>;
}

/**
 * Options for HTML generation
 */
export interface HtmlGeneratorOptions {
  /** Width of the timeline in pixels */
  width?: number;
  /** Height per chain row in pixels */
  rowHeight?: number;
  /** Whether to show balance curves */
  showBalances?: boolean;
  /** Whether to show rebalance markers */
  showRebalances?: boolean;
  /** Title override */
  title?: string;
}

/**
 * Convert SimulationResult to VisualizationData
 */
export function toVisualizationData(
  result: SimulationResult,
  config?: SimulationConfig,
): VisualizationData {
  const events: TimelineEvent[] = [];

  // Collect all chains from transfers and rebalances
  const chainSet = new Set<string>();
  for (const t of result.transferRecords) {
    chainSet.add(t.origin);
    chainSet.add(t.destination);
  }
  for (const r of result.rebalanceRecords) {
    chainSet.add(r.origin);
    chainSet.add(r.destination);
  }

  // Add transfer events
  for (const transfer of result.transferRecords) {
    events.push({
      type: 'transfer_start',
      timestamp: transfer.startTime,
      data: transfer,
    });

    if (transfer.endTime) {
      events.push({
        type:
          transfer.status === 'failed'
            ? 'transfer_failed'
            : 'transfer_complete',
        timestamp: transfer.endTime,
        data: transfer,
      });
    }
  }

  // Add rebalance events (start and complete/fail)
  for (const rebalance of result.rebalanceRecords) {
    // Rebalance start
    events.push({
      type: 'rebalance_start',
      timestamp: rebalance.startTime,
      data: rebalance,
    });
    // Rebalance complete/fail
    if (rebalance.endTime) {
      events.push({
        type:
          rebalance.status === 'failed'
            ? 'rebalance_failed'
            : 'rebalance_complete',
        timestamp: rebalance.endTime,
        data: rebalance,
      });
    }
  }

  // Sort events by timestamp
  events.sort((a, b) => a.timestamp - b.timestamp);

  // Build balance timeline from config's initial collateral
  const chains = Array.from(chainSet).sort();
  const balanceTimeline: Array<{
    timestamp: number;
    balances: Record<string, string>;
  }> = [];

  // Add initial snapshot if config has initial collateral
  if (config?.initialCollateral) {
    const initialBalances: Record<string, string> = {};
    for (const chain of chains) {
      // Convert to wei string (config values are in ether as strings like "100" or "150")
      const value = config.initialCollateral[chain];
      if (value) {
        // If already in wei format (18+ digits), use as-is; otherwise convert from ether
        const numValue = parseFloat(value);
        if (numValue > 1e15) {
          initialBalances[chain] = value;
        } else {
          // Convert ether to wei
          initialBalances[chain] = (
            BigInt(Math.floor(numValue)) * BigInt(1e18)
          ).toString();
        }
      }
    }
    balanceTimeline.push({
      timestamp: result.startTime,
      balances: initialBalances,
    });
  }

  return {
    scenario: result.scenarioName,
    rebalancerName: result.rebalancerName,
    startTime: result.startTime,
    endTime: result.endTime,
    duration: result.duration,
    chains,
    events,
    transfers: result.transferRecords,
    rebalances: result.rebalanceRecords,
    kpis: result.kpis,
    config,
    balanceTimeline,
  };
}
