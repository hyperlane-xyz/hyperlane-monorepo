import { ChainName } from '@hyperlane-xyz/sdk';

/**
 * Represents an event emitted by the monitor containing balance information
 * across different chains and tokens.
 *
 * TODO: The monitor event could emit the same values as
 * typescript/infra/scripts/warp-routes/monitor/monitor-warp-route-balances.ts
 * which might be an excess for the rebalancer but might be required for subscribers to track the same metrics.
 */
export type MonitorEvent = {
  /**
   * Array of objects containing balance information for each token.
   */
  balances: {
    token: string;
    /**
     * The address that holds the amount of tokens represented by value.
     */
    owner: string;
    /**
     * The chain the token lives in.
     */
    chain: ChainName;
    /**
     * The amount of tokens held by the owner.
     */
    value: bigint;
  }[];
};

/**
 * Interface for a monitoring service that tracks token information across different chains.
 */
export interface IMonitor {
  /**
   * Allows subscribers to listen to monitored token data whenever it is emitted.
   */
  subscribe(fn: (event: MonitorEvent) => void): void;

  /**
   * Starts the monitoring long-running process.
   */
  start(): Promise<void>;
}
