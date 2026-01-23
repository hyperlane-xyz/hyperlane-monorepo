import { type Logger } from 'pino';

import {
  EthJsonRpcBlockParameterTag,
  type Token,
  type WarpCore,
} from '@hyperlane-xyz/sdk';
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
 * Awaits the TokenInfo handler before starting the next cycle to prevent race conditions.
 */
export class Monitor implements IMonitor {
  private tokenInfoHandler?: (event: MonitorEvent) => void | Promise<void>;
  private errorHandler?: (event: Error) => void;
  private startHandler?: () => void;
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

  /**
   * Get the confirmed block tag for a chain based on its reorgPeriod.
   * For chains with string reorgPeriod (e.g., "finalized"), returns the string.
   * For chains with numeric reorgPeriod, returns latestBlock - reorgPeriod.
   * Falls back to undefined (latest) if unable to determine.
   */
  private async getConfirmedBlockTag(
    chainName: string,
  ): Promise<number | EthJsonRpcBlockParameterTag | undefined> {
    try {
      const metadata = this.warpCore.multiProvider.getChainMetadata(chainName);
      const reorgPeriod = metadata.blocks?.reorgPeriod ?? 32;

      // Handle string block tags (e.g., "finalized" for Polygon)
      if (typeof reorgPeriod === 'string') {
        return reorgPeriod as EthJsonRpcBlockParameterTag;
      }

      // Handle numeric reorgPeriod: compute latestBlock - reorgPeriod
      const provider =
        this.warpCore.multiProvider.getEthersV5Provider(chainName);
      const latestBlock = await provider.getBlockNumber();
      return Math.max(0, latestBlock - reorgPeriod);
    } catch (error) {
      this.logger.warn(
        { chain: chainName, error: (error as Error).message },
        'Failed to get confirmed block, using latest',
      );
      return undefined;
    }
  }

  // overloads from IMonitor
  on(
    eventName: MonitorEventType.TokenInfo,
    fn: (event: MonitorEvent) => void | Promise<void>,
  ): this;
  on(eventName: MonitorEventType.Error, fn: (event: Error) => void): this;
  on(eventName: MonitorEventType.Start, fn: () => void): this;
  on(eventName: string, fn: (...args: any[]) => void | Promise<void>): this {
    switch (eventName) {
      case MonitorEventType.TokenInfo:
        this.tokenInfoHandler = fn as (
          event: MonitorEvent,
        ) => void | Promise<void>;
        break;
      case MonitorEventType.Error:
        this.errorHandler = fn as (event: Error) => void;
        break;
      case MonitorEventType.Start:
        this.startHandler = fn as () => void;
        break;
    }
    return this;
  }

  async start() {
    if (this.isMonitorRunning) {
      // Cannot start the same monitor multiple times
      this.errorHandler?.(new MonitorStartError('Monitor already running'));
      return;
    }

    try {
      this.isMonitorRunning = true;
      this.logger.debug(
        { checkFrequency: this.checkFrequency },
        'Monitor started',
      );
      this.startHandler?.();

      while (this.isMonitorRunning) {
        const cycleStart = Date.now();

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

          // Await the handler to ensure cycle completes before next poll
          if (this.tokenInfoHandler) {
            await this.tokenInfoHandler(event);
          }
          this.logger.debug('Polling cycle completed');
        } catch (error) {
          this.errorHandler?.(
            new MonitorPollingError(
              `Error during monitor execution cycle: ${(error as Error).message}`,
              error as Error,
            ),
          );
        }

        // Smart sleep: only wait for remaining time after cycle completes
        const elapsed = Date.now() - cycleStart;
        const remaining = this.checkFrequency - elapsed;
        if (remaining > 0) {
          await sleep(remaining);
        }
        // If elapsed >= checkFrequency, start next cycle immediately
      }
    } catch (error) {
      this.errorHandler?.(
        new MonitorStartError(
          `Error starting monitor: ${(error as Error).message}`,
          error as Error,
        ),
      );
    }

    // After the loop has been gracefully terminated, we can clean up.
    this.tokenInfoHandler = undefined;
    this.errorHandler = undefined;
    this.startHandler = undefined;
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

    // Query at confirmed block to sync with Explorer indexing
    const targetBlockTag = await this.getConfirmedBlockTag(token.chainName);
    let bridgedSupply: bigint | undefined;

    try {
      bridgedSupply = await adapter.getBridgedSupply({
        blockTag: targetBlockTag,
      });
      this.logger.debug(
        { chain: token.chainName, targetBlockTag },
        'Queried confirmed balance',
      );
    } catch (error) {
      // Fallback to latest if historical query fails
      this.logger.warn(
        {
          chain: token.chainName,
          targetBlockTag,
          error: (error as Error).message,
        },
        'Historical block query failed, falling back to latest',
      );
      bridgedSupply = await adapter.getBridgedSupply();
    }

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
