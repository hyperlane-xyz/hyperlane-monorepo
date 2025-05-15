import { IRegistry } from '@hyperlane-xyz/registry';
import {
  ChainMap,
  ChainMetadata,
  MultiProtocolProvider,
  WarpCore,
} from '@hyperlane-xyz/sdk';
import { objMap, objMerge } from '@hyperlane-xyz/utils';

import { logDebug } from '../../logger.js';
import { Config } from '../config/Config.js';
import { Executor } from '../executor/Executor.js';
import { WithSemaphore } from '../executor/WithSemaphore.js';
import { IExecutor } from '../interfaces/IExecutor.js';
import { IStrategy } from '../interfaces/IStrategy.js';
import { Metrics } from '../metrics/Metrics.js';
import { PriceGetter } from '../metrics/PriceGetter.js';
import { Monitor } from '../monitor/Monitor.js';
import { StrategyFactory } from '../strategy/StrategyFactory.js';
import { MonitorToStrategyTransformer } from '../transformers/MonitorToStrategyTransformer.js';

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
    logDebug('Creating RebalancerContextFactory');
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
    logDebug('RebalancerContextFactory created successfully');
    return new RebalancerContextFactory(registry, config, metadata, warpCore);
  }

  public async createMetrics(coingeckoApiKey?: string): Promise<Metrics> {
    logDebug('Creating Metrics');
    const tokenPriceGetter = PriceGetter.create(this.metadata, coingeckoApiKey);
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

  public createMonitor(): Monitor {
    logDebug('Creating Monitor');
    return new Monitor(this.config.checkFrequency, this.warpCore);
  }

  public createStrategy(): IStrategy {
    logDebug('Creating Strategy');
    return StrategyFactory.createStrategy(
      this.config.rebalanceStrategy,
      this.config.chains,
    );
  }

  public createExecutor(): IExecutor {
    logDebug('Creating Executor');
    const executor = new Executor(
      objMap(this.config.chains, (_, v) => ({
        bridge: v.bridge,
        minAcceptedAmount: v.bridgeMinAcceptedAmount ?? 0n,
        isWarp: v.bridgeIsWarp ?? false,
      })),
      this.config.rebalancerKey,
      this.warpCore,
      this.metadata,
    );

    return new WithSemaphore(this.config, executor);
  }

  public createMonitorToStrategyTransformer(): MonitorToStrategyTransformer {
    return new MonitorToStrategyTransformer(this.warpCore);
  }
}
