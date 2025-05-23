import { Token } from '@hyperlane-xyz/sdk';

import { WrappedError } from '../../utils/errors.js';

export class MonitorStartError extends WrappedError {
  name = 'MonitorStartError';
}

export class MonitorPollingError extends WrappedError {
  name = 'MonitorPollingError';
}

export enum MonitorEventType {
  TokenInfo = 'tokeninfo',
  Error = 'error',
  Start = 'start',
}

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
  on(
    eventName: MonitorEventType.TokenInfo,
    fn: (event: MonitorEvent) => void,
  ): this;

  /**
   * Allows subscribers to listen to error events.
   */
  on(eventName: MonitorEventType.Error, fn: (event: Error) => void): this;

  /**
   * Allows subscribers to listen to start events.
   */
  on(eventName: MonitorEventType.Start, fn: () => void): this;

  /**
   * Starts the monitoring long-running process.
   */
  start(): Promise<void>;

  /**
   * Stops the monitoring long-running process.
   */
  stop(): void;
}
