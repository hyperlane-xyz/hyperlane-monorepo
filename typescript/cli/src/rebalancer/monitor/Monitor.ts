import EventEmitter from 'events';

import { IRegistry } from '@hyperlane-xyz/registry';
import { MultiProtocolProvider } from '@hyperlane-xyz/sdk';
import { WarpCore } from '@hyperlane-xyz/sdk';
import { objMap, objMerge } from '@hyperlane-xyz/utils';

import { IMonitor, MonitorEvent } from '../interfaces/IMonitor.js';

/**
 * Simple monitor implementation that polls warp route collateral balances and emits them as MonitorEvent.
 */
export class Monitor implements IMonitor {
  private readonly MONITOR_EVENT = 'monitor';
  private readonly emitter = new EventEmitter();
  private interval: NodeJS.Timeout | undefined;

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

  subscribe(fn: (data: MonitorEvent) => void) {
    this.emitter.on(this.MONITOR_EVENT, fn);
  }

  async start() {
    if (this.interval) {
      // Cannot start the same monitor multiple times
      throw new Error('Monitor already running');
    }

    // Build the WarpCore from the registry
    const metadata = await this.registry.getMetadata();
    const addresses = await this.registry.getAddresses();
    const mailboxes = objMap(addresses, (_, { mailbox }) => ({ mailbox }));
    const provider = new MultiProtocolProvider(objMerge(metadata, mailboxes));
    const warpCoreConfig = await this.registry.getWarpRoute(this.warpRouteId);
    const warpCore = WarpCore.FromConfig(provider, warpCoreConfig);

    // Start the interval used to poll collateral balances
    this.interval = setInterval(async () => {
      const event: MonitorEvent = {
        balances: [],
      };

      for (const token of warpCore.tokens) {
        // Ignore non-collateralized tokens given that we only care about collateral balances
        if (!token.isCollateralized()) {
          continue;
        }

        const adapter = token.getHypAdapter(warpCore.multiProvider);

        // Get the bridged supply of the collateral token to obtain how much collateral is available
        const bridgedSupply = await adapter.getBridgedSupply();

        event.balances.push({
          chain: token.chainName,
          owner: token.addressOrDenom,
          token: token.collateralAddressOrDenom!,
          value: bridgedSupply!,
        });
      }

      // Emit the event containing the collateral balances
      this.emitter.emit(this.MONITOR_EVENT, event);
    }, this.checkFrequency);
  }
}
