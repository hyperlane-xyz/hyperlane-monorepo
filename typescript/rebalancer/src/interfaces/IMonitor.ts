import {
  type ChainMap,
  EthJsonRpcBlockParameterTag,
  type Token,
} from '@hyperlane-xyz/sdk';

import { WrappedError } from '../utils/errors.js';

export class MonitorStartError extends WrappedError {
  name = 'MonitorStartError';
}

export class MonitorPollingError extends WrappedError {
  name = 'MonitorPollingError';
}

export enum MonitorEventType {
  TokenInfo = 'TokenInfo',
  Error = 'Error',
  Start = 'Start',
}

export type ConfirmedBlockTag =
  | number
  | EthJsonRpcBlockParameterTag
  | undefined;

export type ConfirmedBlockTags = ChainMap<ConfirmedBlockTag>;

export type MonitorEvent = {
  tokensInfo: {
    token: Token;
    bridgedSupply?: bigint;
  }[];
  confirmedBlockTags: ConfirmedBlockTags;
};

/**
 * Interface for a monitoring service that tracks token information across different chains.
 */
export interface IMonitor {
  /**
   * Allows subscribers to listen to hyperlane's tokens info.
   * Handler can be async - Monitor will await it before starting next cycle.
   */
  on(
    eventName: MonitorEventType.TokenInfo,
    fn: (event: MonitorEvent) => void | Promise<void>,
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
