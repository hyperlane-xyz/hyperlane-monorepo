import { Token } from '@hyperlane-xyz/sdk';

/**
 * Represents an event emitted by the monitor containing bridgedSupply and token information.
 */
export type MonitorEvent = {
  /**
   * Collection of objects containing the information retrieved by the Monitor.
   */
  tokensInfo: {
    token: Token;
    bridgedSupply?: bigint;
  }[];
};

/**
 * Interface for a monitoring service that tracks token information across different chains.
 */
export interface IMonitor {
  /**
   * Allows subscribers to listen to hyperlane's tokens info.
   */
  on(eventName: 'tokeninfo', fn: (event: MonitorEvent) => void): this;

  /**
   * Allows subscribers to listen to error events.
   */
  on(eventName: 'error', fn: (event: Error) => void): this;

  /**
   * Allows subscribers to listen to start events.
   */
  on(eventName: 'start', fn: () => void): this;

  /**
   * Starts the monitoring long-running process.
   */
  start(): Promise<void>;

  /**
   * Stops the monitoring long-running process.
   */
  stop(): void;
}
