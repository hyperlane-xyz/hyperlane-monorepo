import EventEmitter from 'events';

import { IRegistry } from '@hyperlane-xyz/registry';
import { MultiProtocolProvider, Token, WarpCore } from '@hyperlane-xyz/sdk';
import { objMap, objMerge, sleep } from '@hyperlane-xyz/utils';

import { WrappedError } from '../../utils/errors.js';
import { IMonitor, MonitorEvent } from '../interfaces/IMonitor.js';
import { logger } from '../metrics/utils.js';

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
   * @param registry - The registry that contains a collection of configs, artifacts, and schemas for Hyperlane.
   * @param warpRouteId - The warp route ID to monitor.
   * @param checkFrequency - The frequency to poll balances in ms.
   */
  constructor(
    private readonly registry: IRegistry,
    private readonly warpRouteId: string,
    private readonly checkFrequency: number,
  ) {}

  on(
    eventName: 'collateralbalances' | 'start' | 'error',
    fn: (...args: any[]) => void,
  ) {
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

      // Build the WarpCore from the registry
      const metadata = await this.registry.getMetadata();
      const addresses = await this.registry.getAddresses();

      // The Sealevel warp adapters require the Mailbox address, so we
      // get mailboxes for all chains and merge them with the chain metadata.
      const mailboxes = objMap(addresses, (_, { mailbox }) => ({ mailbox }));
      const provider = new MultiProtocolProvider(objMerge(metadata, mailboxes));
      const warpCoreConfig = await this.registry.getWarpRoute(this.warpRouteId);
      const warpCore = WarpCore.FromConfig(provider, warpCoreConfig);

      // this can be considered the starting point of the monitor
      this.emitter.emit('start');

      while (this.isMonitorRunning) {
        try {
          const event: MonitorEvent = {
            balances: [],
            token: null,
          };

          for (const token of warpCore.tokens) {
            const bridgedSupply = await this.getTokenBridgedSupply(
              token,
              warpCore,
            );

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
    warpCore: WarpCore,
  ): Promise<bigint | undefined> {
    if (!token.isHypToken()) {
      logger.warn(
        'Cannot get bridged balance for a non-Hyperlane token',
        token,
      );
      return;
    }

    const adapter = token.getHypAdapter(warpCore.multiProvider);
    const bridgedSupply = await adapter.getBridgedSupply();

    if (bridgedSupply === undefined) {
      logger.warn('Bridged supply not found for token', token);
    }

    return bridgedSupply;
  }

  stop() {
    this.isMonitorRunning = false;
    this.emitter.removeAllListeners();
  }
}
