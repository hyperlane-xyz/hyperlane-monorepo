import { logger } from 'ethers';
import EventEmitter from 'events';

import type { Token, WarpCore } from '@hyperlane-xyz/sdk';
import { sleep } from '@hyperlane-xyz/utils';

import { log, logDebug } from '../../logger.js';
import { WrappedError } from '../../utils/errors.js';
import type { IMonitor, MonitorEvent } from '../interfaces/IMonitor.js';

export class MonitorStartError extends WrappedError {
  name = 'MonitorStartError';
}

export class MonitorPollingError extends WrappedError {
  name = 'MonitorPollingError';
}

/**
 * Simple monitor implementation that polls warp route collateral balances and emits them as MonitorEvent.
 */
export class Monitor implements IMonitor {
  private readonly emitter = new EventEmitter();
  private isMonitorRunning = false;

  /**
   * @param checkFrequency - The frequency to poll balances in ms.
   */
  constructor(
    private readonly checkFrequency: number,
    private readonly warpCore: WarpCore,
  ) {}

  // overloads from IMonitor
  on(eventName: 'tokeninfo', fn: (event: MonitorEvent) => void): this;
  on(eventName: 'error', fn: (event: Error) => void): this;
  on(eventName: 'start', fn: () => void): this;
  on(eventName: string, fn: (...args: any[]) => void): this {
    this.emitter.on(eventName, fn);
    return this;
  }

  async start() {
    if (this.isMonitorRunning) {
      // Cannot start the same monitor multiple times
      this.emitter.emit(
        'error',
        new MonitorStartError('Monitor already running'),
      );
      return;
    }

    try {
      this.isMonitorRunning = true;
      logDebug('Monitor started');
      this.emitter.emit('start');

      while (this.isMonitorRunning) {
        try {
          logDebug('Polling cycle started');
          const event: MonitorEvent = {
            tokensInfo: [],
          };

          for (const token of this.warpCore.tokens) {
            logDebug(`Checking token: ${token.chainName}`);
            const bridgedSupply = await this.getTokenBridgedSupply(token);

            event.tokensInfo.push({
              token,
              bridgedSupply,
            });
          }

          // Emit the event warp routes info
          this.emitter.emit('tokeninfo', event);
          logDebug('Polling cycle completed');
        } catch (e) {
          this.emitter.emit(
            'error',
            new MonitorPollingError(
              `Error during monitor execution cycle: ${(e as Error).message}`,
              e as Error,
            ),
          );
        }

        // Wait for the specified check frequency before the next iteration
        await sleep(this.checkFrequency);
      }
    } catch (e) {
      this.emitter.emit(
        'error',
        new MonitorStartError(
          `Error starting monitor: ${(e as Error).message}`,
          e as Error,
        ),
      );
    }
  }

  private async getTokenBridgedSupply(
    token: Token,
  ): Promise<bigint | undefined> {
    if (!token.isHypToken()) {
      logger.warn(
        'Cannot get bridged balance for a non-Hyperlane token',
        token,
      );
      return;
    }

    const adapter = token.getHypAdapter(this.warpCore.multiProvider);
    const bridgedSupply = await adapter.getBridgedSupply();

    if (bridgedSupply === undefined) {
      logger.warn('Bridged supply not found for token', token);
    }

    return bridgedSupply;
  }

  stop() {
    this.isMonitorRunning = false;
    log('Monitor stopped');
    this.emitter.removeAllListeners();
  }
}
