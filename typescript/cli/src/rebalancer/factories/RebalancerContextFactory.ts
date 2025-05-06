import { IRegistry } from '@hyperlane-xyz/registry';
import {
  ChainMap,
  ChainMetadata,
  MultiProtocolProvider,
  WarpCore,
} from '@hyperlane-xyz/sdk';
import { objMap, objMerge } from '@hyperlane-xyz/utils';

import { Metrics } from '../metrics/Metrics.js';
import { PriceGetter } from '../metrics/PriceGetter.js';
import { Monitor } from '../monitor/Monitor.js';

export class RebalancerContextFactory {
  /**
   * @param registry - The registry that contains a collection of configs, artifacts, and schemas for Hyperlane.
   * @param warpRouteId - The warp route ID to monitor.
   * @param metadata - A `ChainMap` of chain names and `ChainMetadata` objects, sourced from the `IRegistry`.
   * @param warpCore - An instance of `WarpCore` configured for the specified `warpRouteId`.
   */
  private constructor(
    private readonly registry: IRegistry,
    private readonly warpRouteId: string,
    private readonly metadata: ChainMap<ChainMetadata>,
    private readonly warpCore: WarpCore,
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
    if (!warpCoreConfig) {
      throw new Error(
        `Warp route config for ${warpRouteId} not found in registry`,
      );
    }
    const warpCore = WarpCore.FromConfig(provider, warpCoreConfig);

    return new RebalancerContextFactory(
      registry,
      warpRouteId,
      metadata,
      warpCore,
    );
  }

  public async createMetrics(): Promise<Metrics> {
    const tokenPriceGetter = await PriceGetter.create(this.metadata);
    const collateralTokenSymbol = Metrics.getWarpRouteCollateralTokenSymbol(
      this.warpCore,
    );
    const warpDeployConfig = await this.registry.getWarpDeployConfig(
      this.warpRouteId,
    );

    return new Metrics(
      tokenPriceGetter,
      collateralTokenSymbol,
      warpDeployConfig,
      this.warpCore,
    );
  }

  public createMonitor(checkFrequency: number): Monitor {
    return new Monitor(checkFrequency, this.warpCore);
  }
}
