import {
  type ChainMap,
  type ChainMetadata,
  type Token,
  WarpCore,
} from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

import type { WriteCommandContext } from '../../context/types.js';
import { RebalancerConfig } from '../config/RebalancerConfig.js';
import { Rebalancer } from '../core/Rebalancer.js';
import { WithSemaphore } from '../core/WithSemaphore.js';
import type { IRebalancer } from '../interfaces/IRebalancer.js';
import type { IStrategy } from '../interfaces/IStrategy.js';
import { Metrics } from '../metrics/Metrics.js';
import { PriceGetter } from '../metrics/PriceGetter.js';
import { Monitor } from '../monitor/Monitor.js';
import { StrategyFactory } from '../strategy/StrategyFactory.js';
import {
  isCollateralizedTokenEligibleForRebalancing,
  rebalancerLogger,
} from '../utils/index.js';

export class RebalancerContextFactory {
  /**
   * @param config - The rebalancer config
   * @param metadata - A `ChainMap` of chain names and `ChainMetadata` objects, sourced from the `IRegistry`.
   * @param warpCore - An instance of `WarpCore` configured for the specified `warpRouteId`.
   * @param tokensByChainName - A map of chain->token to ease the lookup of token by chain
   * @param context - CLI context
   */
  private constructor(
    private readonly config: RebalancerConfig,
    private readonly metadata: ChainMap<ChainMetadata>,
    private readonly warpCore: WarpCore,
    private readonly tokensByChainName: ChainMap<Token>,
    private readonly context: WriteCommandContext,
  ) {}

  /**
   * @param config - The rebalancer config
   * @param context - CLI context
   */
  public static async create(
    config: RebalancerConfig,
    context: WriteCommandContext,
  ): Promise<RebalancerContextFactory> {
    rebalancerLogger.debug(
      {
        warpRouteId: config.warpRouteId,
      },
      'Creating RebalancerContextFactory',
    );
    const { registry } = context;
    const metadata = await registry.getMetadata();
    const addresses = await registry.getAddresses();

    // The Sealevel warp adapters require the Mailbox address, so we
    // get mailboxes for all chains and merge them with the chain metadata.
    const mailboxes = objMap(addresses, (_, { mailbox }) => ({ mailbox }));
    const provider =
      context.multiProtocolProvider.extendChainMetadata(mailboxes);

    const warpCoreConfig = await registry.getWarpRoute(config.warpRouteId);
    if (!warpCoreConfig) {
      throw new Error(
        `Warp route config for ${config.warpRouteId} not found in registry`,
      );
    }
    const warpCore = WarpCore.FromConfig(provider, warpCoreConfig);
    const tokensByChainName = Object.fromEntries(
      warpCore.tokens.map((t) => [t.chainName, t]),
    );

    rebalancerLogger.debug(
      {
        warpRouteId: config.warpRouteId,
      },
      'RebalancerContextFactory created successfully',
    );
    return new RebalancerContextFactory(
      config,
      metadata,
      warpCore,
      tokensByChainName,
      context,
    );
  }

  public getWarpCore(): WarpCore {
    return this.warpCore;
  }

  public getTokenForChain(chainName: string): Token | undefined {
    return this.tokensByChainName[chainName];
  }

  public async createMetrics(coingeckoApiKey?: string): Promise<Metrics> {
    rebalancerLogger.debug(
      { warpRouteId: this.config.warpRouteId },
      'Creating Metrics',
    );
    const tokenPriceGetter = PriceGetter.create(this.metadata, coingeckoApiKey);
    const warpDeployConfig = await this.context.registry.getWarpDeployConfig(
      this.config.warpRouteId,
    );

    return new Metrics(
      tokenPriceGetter,
      warpDeployConfig,
      this.warpCore,
      this.config.warpRouteId,
    );
  }

  public createMonitor(checkFrequency: number): Monitor {
    rebalancerLogger.debug(
      {
        warpRouteId: this.config.warpRouteId,
        checkFrequency: checkFrequency,
      },
      'Creating Monitor',
    );
    return new Monitor(checkFrequency, this.warpCore);
  }

  public async createStrategy(metrics?: Metrics): Promise<IStrategy> {
    rebalancerLogger.debug(
      {
        warpRouteId: this.config.warpRouteId,
        strategyType: this.config.strategyConfig.rebalanceStrategy,
      },
      'Creating Strategy',
    );
    return StrategyFactory.createStrategy(
      this.config.strategyConfig,
      this.tokensByChainName,
      await this.getInitialTotalCollateral(),
      metrics,
    );
  }

  public createRebalancer(): IRebalancer {
    rebalancerLogger.debug(
      { warpRouteId: this.config.warpRouteId },
      'Creating Rebalancer',
    );
    const rebalancer = new Rebalancer(
      objMap(this.config.strategyConfig.chains, (_, v) => ({
        bridge: v.bridge,
        bridgeMinAcceptedAmount: v.bridgeMinAcceptedAmount ?? 0,
        bridgeIsWarp: v.bridgeIsWarp ?? false,
        override: v.override,
      })),
      this.warpCore,
      this.metadata,
      this.tokensByChainName,
      this.context.multiProvider,
    );

    return new WithSemaphore(this.config, rebalancer);
  }

  private async getInitialTotalCollateral(): Promise<bigint> {
    let initialTotalCollateral = 0n;

    const chainNames = new Set(Object.keys(this.config.strategyConfig.chains));

    for (const token of this.warpCore.tokens) {
      if (
        isCollateralizedTokenEligibleForRebalancing(token) &&
        token.collateralAddressOrDenom &&
        chainNames.has(token.chainName)
      ) {
        const adapter = token.getHypAdapter(this.warpCore.multiProvider);
        const bridgedSupply = await adapter.getBridgedSupply();

        initialTotalCollateral += bridgedSupply ?? 0n;
      }
    }

    return initialTotalCollateral;
  }
}
