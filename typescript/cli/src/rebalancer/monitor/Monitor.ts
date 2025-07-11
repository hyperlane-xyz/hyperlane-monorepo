import EventEmitter from 'events';
import { Logger } from 'pino';

import type { Token, WarpCore } from '@hyperlane-xyz/sdk';
import { sleep } from '@hyperlane-xyz/utils';

import {
  type IMonitor,
  type MonitorEvent,
  MonitorEventType,
  MonitorPollingError,
  MonitorStartError,
} from '../interfaces/IMonitor.js';

/**
 * Simple monitor implementation that polls warp route collateral balances and emits them as MonitorEvent.
 */
export class Monitor implements IMonitor {
  private readonly emitter = new EventEmitter();
  private isMonitorRunning = false;
  private resolveStop: (() => void) | null = null;
  private stopPromise: Promise<void> | null = null;

  /**
   * @param checkFrequency - The frequency to poll balances in ms.
   */
  constructor(
    private readonly checkFrequency: number,
    private readonly warpCore: WarpCore,
    private readonly logger: Logger,
  ) {}

  // overloads from IMonitor
  on(
    eventName: MonitorEventType.TokenInfo,
    fn: (event: MonitorEvent) => void,
  ): this;
  on(eventName: MonitorEventType.Error, fn: (event: Error) => void): this;
  on(eventName: MonitorEventType.Start, fn: () => void): this;
  on(eventName: string, fn: (...args: any[]) => void): this {
    this.emitter.on(eventName, fn);
    return this;
  }

  async start() {
    if (this.isMonitorRunning) {
      // Cannot start the same monitor multiple times
      this.emitter.emit(
        MonitorEventType.Error,
        new MonitorStartError('Monitor already running'),
      );
      return;
    }

    try {
      this.isMonitorRunning = true;
      this.logger.debug(
        { checkFrequency: this.checkFrequency },
        'Monitor started',
      );
      this.emitter.emit(MonitorEventType.Start);

      while (this.isMonitorRunning) {
        try {
          this.logger.debug('Polling cycle started');
          const event: MonitorEvent = {
            tokensInfo: [],
          };

          for (const token of this.warpCore.tokens) {
            this.logger.debug(
              {
                chain: token.chainName,
                tokenSymbol: token.symbol,
                tokenAddress: token.addressOrDenom,
              },
              'Checking token',
            );
            const bridgedSupply = await this.getTokenBridgedSupply(token);

            event.tokensInfo.push({
              token,
              bridgedSupply,
            });
          }

          // Emit the event warp routes info
          this.emitter.emit(MonitorEventType.TokenInfo, event);
          this.logger.debug('Polling cycle completed');
        } catch (error) {
          this.emitter.emit(
            MonitorEventType.Error,
            new MonitorPollingError(
              `Error during monitor execution cycle: ${(error as Error).message}`,
              error as Error,
            ),
          );
        }

        // Wait for the specified check frequency before the next iteration
        await sleep(this.checkFrequency);
      }
    } catch (error) {
      this.emitter.emit(
        MonitorEventType.Error,
        new MonitorStartError(
          `Error starting monitor: ${(error as Error).message}`,
          error as Error,
        ),
      );
    }

    // After the loop has been gracefully terminated, we can clean up.
    this.emitter.removeAllListeners();
    this.logger.info('Monitor stopped');

    // If stop() was called, resolve the promise to signal that we're done.
    if (this.resolveStop) {
      this.resolveStop();
      this.resolveStop = null;
      this.stopPromise = null;
    }
  }

  private async getTokenBridgedSupply(
    token: Token,
  ): Promise<bigint | undefined> {
    if (!token.isHypToken()) {
      this.logger.warn(
        {
          chain: token.chainName,
          tokenSymbol: token.symbol,
          tokenAddress: token.addressOrDenom,
        },
        'Cannot get bridged balance for a non-Hyperlane token',
      );
      return;
    }

    const adapter = token.getHypAdapter(this.warpCore.multiProvider);
    const bridgedSupply = await adapter.getBridgedSupply();

    if (bridgedSupply === undefined) {
      this.logger.warn(
        {
          chain: token.chainName,
          tokenSymbol: token.symbol,
          tokenAddress: token.addressOrDenom,
        },
        'Bridged supply not found for token',
      );
    }

    return bridgedSupply;
  }

  stop(): Promise<void> {
    if (!this.isMonitorRunning) return Promise.resolve();

    // If stop is already in progress, return the existing promise
    if (this.stopPromise) return this.stopPromise;

    this.logger.info('Stopping monitor...');
    // Signal the while loop to terminate after its current iteration
    this.isMonitorRunning = false;

    // Create a promise that will be resolved by the start() method
    // once the loop and cleanup are complete.
    this.stopPromise = new Promise((resolve) => {
      this.resolveStop = resolve;
    });
    return this.stopPromise;
  }
}
