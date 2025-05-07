import { IRegistry } from '@hyperlane-xyz/registry';
import {
  ChainMap,
  ChainMetadata,
  MultiProtocolProvider,
  WarpCore,
} from '@hyperlane-xyz/sdk';
import { objMap, objMerge } from '@hyperlane-xyz/utils';

import { Config } from '../config/Config.js';
import { Executor } from '../executor/Executor.js';
import { MonitorOnlyExecutor } from '../executor/MonitorOnlyExecutor.js';
import { IExecutor } from '../interfaces/IExecutor.js';
import { Metrics } from '../metrics/Metrics.js';
import { PriceGetter } from '../metrics/PriceGetter.js';
import { Monitor } from '../monitor/Monitor.js';
import { Strategy } from '../strategy/Strategy.js';

export class RebalancerContextFactory {
  /**
   * @param registry - The registry that contains a collection of configs, artifacts, and schemas for Hyperlane.
   * @param config - The rebalancer config
   * @param metadata - A `ChainMap` of chain names and `ChainMetadata` objects, sourced from the `IRegistry`.
   * @param warpCore - An instance of `WarpCore` configured for the specified `warpRouteId`.
   */
  private constructor(
    private readonly registry: IRegistry,
    private readonly config: Config,
    private readonly metadata: ChainMap<ChainMetadata>,
    private readonly warpCore: WarpCore,
  ) {}

  /**
   * @param registry - The registry that contains a collection of configs, artifacts, and schemas for Hyperlane.
   * @param config - The rebalancer config
   */
  public static async create(
    registry: IRegistry,
    config: Config,
  ): Promise<RebalancerContextFactory> {
    const metadata = await registry.getMetadata();
    const addresses = await registry.getAddresses();

    // The Sealevel warp adapters require the Mailbox address, so we
    // get mailboxes for all chains and merge them with the chain metadata.
    const mailboxes = objMap(addresses, (_, { mailbox }) => ({ mailbox }));
    const provider = new MultiProtocolProvider(objMerge(metadata, mailboxes));
    const warpCoreConfig = await registry.getWarpRoute(config.warpRouteId);
    if (!warpCoreConfig) {
      throw new Error(
        `Warp route config for ${config.warpRouteId} not found in registry`,
      );
    }
    const warpCore = WarpCore.FromConfig(provider, warpCoreConfig);

    return new RebalancerContextFactory(registry, config, metadata, warpCore);
  }

  public async createMetrics(): Promise<Metrics> {
    const tokenPriceGetter = PriceGetter.create(this.metadata);
    const collateralTokenSymbol = Metrics.getWarpRouteCollateralTokenSymbol(
      this.warpCore,
    );
    const warpDeployConfig = await this.registry.getWarpDeployConfig(
      this.config.warpRouteId,
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

  public createStrategy(): Strategy {
    return new Strategy(
      objMap(this.config.chains, (_, v) => ({
        weight: v.weight,
        tolerance: v.tolerance,
      })),
    );
  }

  public createExecutor(rebalancerKey: string): IExecutor {
    if (this.config.monitorOnly) {
      return new MonitorOnlyExecutor();
    }

    return new Executor(
      objMap(this.config.chains, (_, v) => v.bridge),
      rebalancerKey,
      this.warpCore,
      this.metadata,
    );
  }
}
