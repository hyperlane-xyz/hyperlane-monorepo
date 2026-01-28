import type { Address } from '@hyperlane-xyz/utils';

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
