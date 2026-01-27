import type { Address } from '@hyperlane-xyz/utils';

/**
 * Transfer scenario definition for simulation
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
 * Serialized scenario for JSON storage
 */
export interface SerializedScenario {
  name: string;
  duration: number;
  chains: string[];
  transfers: SerializedTransferEvent[];
}
