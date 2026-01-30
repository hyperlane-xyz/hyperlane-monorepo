import type { WarpCoreConfig } from '@hyperlane-xyz/sdk';

import type { MultiDomainDeploymentResult } from '../deployment/types.js';

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
