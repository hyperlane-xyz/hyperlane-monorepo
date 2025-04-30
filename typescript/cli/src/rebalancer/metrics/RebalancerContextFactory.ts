import { IRegistry } from '@hyperlane-xyz/registry';
import {
  MultiProtocolProvider,
  WarpCore,
  WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { objMap, objMerge } from '@hyperlane-xyz/utils';

import { Monitor } from '../monitor/Monitor.js';

import { Metrics } from './Metrics.js';
import { PriceGetter } from './PriceGetter.js';

export class RebalancerContextFactory {
  /**
   * @param registry - The registry that contains a collection of configs, artifacts, and schemas for Hyperlane.
   * @param warpRouteId - The warp route ID to monitor.
   * @param tokenPriceGetter
   * @param collateralTokenSymbol
   * @param warpCore
   * @param warpDeployConfig
   */
  private constructor(
    private readonly tokenPriceGetter: PriceGetter,
    private readonly collateralTokenSymbol: string,
    private readonly warpCore: WarpCore,
    private readonly warpDeployConfig: WarpRouteDeployConfig | null,
  ) {}

  /**
   * @param registry - The registry that contains a collection of configs, artifacts, and schemas for Hyperlane.
   * @param warpRouteId - The warp route ID to monitor.
   */
  public static async create(
    registry: IRegistry,
    warpRouteId: string,
  ): Promise<RebalancerContextFactory> {
    const metadata = await registry.getMetadata();
    const addresses = await registry.getAddresses();

    // The Sealevel warp adapters require the Mailbox address, so we
    // get mailboxes for all chains and merge them with the chain metadata.
    const mailboxes = objMap(addresses, (_, { mailbox }) => ({ mailbox }));
    const provider = new MultiProtocolProvider(objMerge(metadata, mailboxes));
    const warpCoreConfig = await registry.getWarpRoute(warpRouteId);
    const warpCore = WarpCore.FromConfig(provider, warpCoreConfig);
    const warpDeployConfig = await registry.getWarpDeployConfig(warpRouteId);
    const collateralTokenSymbol =
      Metrics.getWarpRouteCollateralTokenSymbol(warpCore);
    const tokenPriceGetter = await PriceGetter.create(metadata);

    return new RebalancerContextFactory(
      tokenPriceGetter,
      collateralTokenSymbol,
      warpCore,
      warpDeployConfig,
    );
  }

  public createMetrics(): Metrics {
    return new Metrics(
      this.tokenPriceGetter,
      this.collateralTokenSymbol,
      this.warpCore,
      this.warpDeployConfig,
    );
  }

  public createMonitor(checkFrequency: number): Monitor {
    return new Monitor(checkFrequency, this.warpCore);
  }
}
