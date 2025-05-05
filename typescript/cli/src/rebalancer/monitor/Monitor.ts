import EventEmitter from 'events';

import { Token, WarpCore } from '@hyperlane-xyz/sdk';
import { sleep } from '@hyperlane-xyz/utils';

import { warnYellow } from '../../logger.js';
import { WrappedError } from '../../utils/errors.js';
import { IMonitor, MonitorEvent } from '../interfaces/IMonitor.js';

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
  on(eventName: 'collateralbalances', fn: (event: MonitorEvent) => void): this;
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
      this.emitter.emit('start');

      while (this.isMonitorRunning) {
        try {
          const event: MonitorEvent = {
            balances: [],
            token: null,
          };

          for (const token of this.warpCore.tokens) {
            const bridgedSupply = await this.getTokenBridgedSupply(token);

            // data required for the rebalancer
            function rebalancerData(
              token: Token,
              bridgedSupply?: bigint,
            ): MonitorEvent['balances'][number] | undefined {
              // Ignore non-collateralized tokens given that we only care about collateral balances
              if (!token.isCollateralized()) {
                return;
              }

              // Ignore tokens without bridged supply
              if (bridgedSupply === undefined) {
                return;
              }

              return {
                chain: token.chainName,
                owner: token.addressOrDenom,
                token: token.collateralAddressOrDenom!,
                value: bridgedSupply,
              };
            }

            // data required for the metrics
            function metricsData(token: Token, bridgedSupply?: bigint) {
              return {
                token,
                bridgedSupply,
              };
            }

            const balances = rebalancerData(token, bridgedSupply);
            if (balances) {
              event.balances.push(balances);
            }

            const metrics = metricsData(token, bridgedSupply);
            event.token = metrics.token;
            event.bridgedSupply = metrics.bridgedSupply;
          }

          // Emit the event containing the collateral balances
          this.emitter.emit('collateralbalances', event);
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
      warnYellow('Cannot get bridged balance for a non-Hyperlane token', token);
      return;
    }

    const adapter = token.getHypAdapter(this.warpCore.multiProvider);
    const bridgedSupply = await adapter.getBridgedSupply();

    if (bridgedSupply === undefined) {
      warnYellow('Bridged supply not found for token', token);
    }

    return bridgedSupply;
  }

  stop() {
    this.isMonitorRunning = false;
    this.emitter.removeAllListeners();
  }
}
