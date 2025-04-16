import { ChainName } from '@hyperlane-xyz/sdk';

import { MonitorEvent } from './IMonitor.js';

/**
 * Represents an event emitted by the strategy containing routing information
 * for token rebalancing across different chains.
 */
export type StrategyEvent = {
  /**
   * Array of objects containing routing information for token transfers.
   * It is an array given that rebalancing might require multiple asset movements.
   */
  route: {
    /**
     * The source chain where tokens will be transferred from.
     */
    origin: ChainName;
    /**
     * The target chain where tokens will be transferred to.
     */
    destination: ChainName;
    /**
     * The address of the token to be transferred.
     */
    token: string;
    /**
     * The amount of tokens to be transferred.
     */
    amount: bigint;
  }[];
};

/**
 * Interface for a strategy service that determines optimal token routing
 * based on monitored balance information.
 */
export interface IStrategy {
  /**
   * Allows subscribers to listen to rebalancing requirements whenever they are emitted.
   */
  subscribe(fn: (event: StrategyEvent) => void): void;

  /**
   * Processes balance information from the monitor and determines if rebalancing is needed.
   * Should emit a StrategyEvent containing the rebalancing requirements.
   */
  handleMonitorEvent(event: MonitorEvent): Promise<void>;
}
