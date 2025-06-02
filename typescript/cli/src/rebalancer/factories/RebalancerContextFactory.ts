import {
  type ChainMap,
  type ChainMetadata,
  MultiProtocolProvider,
  type Token,
  WarpCore,
} from '@hyperlane-xyz/sdk';
import { objMap, objMerge } from '@hyperlane-xyz/utils';

import type { WriteCommandContext } from '../../context/types.js';
import { RebalancerConfig } from '../config/RebalancerConfig.js';
import type { IRebalancer } from '../interfaces/IRebalancer.js';
import type { IStrategy } from '../interfaces/IStrategy.js';
import { Metrics } from '../metrics/Metrics.js';
import { PriceGetter } from '../metrics/PriceGetter.js';
import { Monitor } from '../monitor/Monitor.js';
import { Rebalancer } from '../rebalancer/Rebalancer.js';
import { WithSemaphore } from '../rebalancer/WithSemaphore.js';
import { StrategyFactory } from '../strategy/StrategyFactory.js';
import { isCollateralizedTokenEligibleForRebalancing } from '../utils/isCollateralizedTokenEligibleForRebalancing.js';
import { rebalancerLogger } from '../utils/logger.js';

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
    const provider = new MultiProtocolProvider(objMerge(metadata, mailboxes));
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

  public async createMetrics(coingeckoApiKey?: string): Promise<Metrics> {
    rebalancerLogger.debug(
      { warpRouteId: this.config.warpRouteId },
      'Creating Metrics',
    );
    const tokenPriceGetter = PriceGetter.create(this.metadata, coingeckoApiKey);
    const collateralTokenSymbol = Metrics.getWarpRouteCollateralTokenSymbol(
      this.warpCore,
    );
    const warpDeployConfig = await this.context.registry.getWarpDeployConfig(
      this.config.warpRouteId,
    );

    return new Metrics(
      tokenPriceGetter,
      collateralTokenSymbol,
      warpDeployConfig,
      this.warpCore,
      this.config.warpRouteId,
    );
  }

  public createMonitor(): Monitor {
    rebalancerLogger.debug(
      {
        warpRouteId: this.config.warpRouteId,
        checkFrequency: this.config.checkFrequency,
      },
      'Creating Monitor',
    );
    return new Monitor(this.config.checkFrequency, this.warpCore);
  }

  public async createStrategy(): Promise<IStrategy> {
    rebalancerLogger.debug(
      {
        warpRouteId: this.config.warpRouteId,
        strategyType: this.config.rebalanceStrategy,
      },
      'Creating Strategy',
    );
    return StrategyFactory.createStrategy(
      this.config.rebalanceStrategy,
      this.config.chains,
      this.tokensByChainName,
      await this.getInitialTotalCollateral(),
    );
  }

  public createRebalancer(): IRebalancer {
    rebalancerLogger.debug(
      { warpRouteId: this.config.warpRouteId },
      'Creating Rebalancer',
    );
    const rebalancer = new Rebalancer(
      objMap(this.config.chains, (_, v) => ({
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

    const chainNames = new Set(Object.keys(this.config.chains));

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
