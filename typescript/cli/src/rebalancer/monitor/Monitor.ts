import EventEmitter from 'events';

import type { Token, WarpCore } from '@hyperlane-xyz/sdk';
import { sleep } from '@hyperlane-xyz/utils';

import { log, logDebug, warnYellow } from '../../logger.js';
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

  /**
   * @param checkFrequency - The frequency to poll balances in ms.
   */
  constructor(
    private readonly checkFrequency: number,
    private readonly warpCore: WarpCore,
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
      logDebug(`Monitor started, polling every ${this.checkFrequency} ms...`);
      this.emitter.emit(MonitorEventType.Start);

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
          this.emitter.emit(MonitorEventType.TokenInfo, event);
          logDebug('Polling cycle completed');
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
  }

  private async getTokenBridgedSupply(
    token: Token,
  ): Promise<bigint | undefined> {
    if (!token.isHypToken()) {
      warnYellow(
        `Cannot get bridged balance for a non-Hyperlane token: ${token.chainName}`,
      );
      return;
    }

    const adapter = token.getHypAdapter(this.warpCore.multiProvider);
    const bridgedSupply = await adapter.getBridgedSupply();

    if (bridgedSupply === undefined) {
      warnYellow(`Bridged supply not found for token: ${token.chainName}`);
    }

    return bridgedSupply;
  }

  stop() {
    this.isMonitorRunning = false;
    log('Monitor stopped');
    this.emitter.removeAllListeners();
  }
}
