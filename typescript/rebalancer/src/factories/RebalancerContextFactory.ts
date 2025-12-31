import { Logger } from 'pino';

import { IRegistry } from '@hyperlane-xyz/registry';
import {
  type ChainMap,
  MultiProtocolProvider,
  MultiProvider,
  type Token,
  WarpCore,
  getStrategyChainConfig,
  getStrategyChainNames,
} from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

import { RebalancerConfig } from '../config/RebalancerConfig.js';
import { DEFAULT_EXPLORER_URL } from '../consts.js';
import { Rebalancer } from '../core/Rebalancer.js';
import { WithSemaphore } from '../core/WithSemaphore.js';
import type { IRebalancer } from '../interfaces/IRebalancer.js';
import type { IStrategy } from '../interfaces/IStrategy.js';
import { Metrics } from '../metrics/Metrics.js';
import { PriceGetter } from '../metrics/PriceGetter.js';
import { Monitor } from '../monitor/Monitor.js';
import { StrategyFactory } from '../strategy/StrategyFactory.js';
import { MessageTracker } from '../tracker/MessageTracker.js';
import { isCollateralizedTokenEligibleForRebalancing } from '../utils/index.js';

export class RebalancerContextFactory {
  /**
   * @param config - The rebalancer config
   * @param warpCore - An instance of `WarpCore` configured for the specified `warpRouteId`.
   * @param tokensByChainName - A map of chain->token to ease the lookup of token by chain
   * @param multiProvider - MultiProvider instance
   * @param registry - IRegistry instance
   * @param logger - Logger instance
   */
  private constructor(
    private readonly config: RebalancerConfig,
    private readonly warpCore: WarpCore,
    private readonly tokensByChainName: ChainMap<Token>,
    private readonly multiProvider: MultiProvider,
    private readonly registry: IRegistry,
    private readonly logger: Logger,
  ) {}

  /**
   * @param config - The rebalancer config
   * @param multiProvider - MultiProvider instance
   * @param multiProtocolProvider - MultiProtocolProvider instance (optional, created from multiProvider if not provided)
   * @param registry - IRegistry instance
   * @param logger - Logger instance
   */
  public static async create(
    config: RebalancerConfig,
    multiProvider: MultiProvider,
    multiProtocolProvider: MultiProtocolProvider | undefined,
    registry: IRegistry,
    logger: Logger,
  ): Promise<RebalancerContextFactory> {
    logger.debug(
      {
        warpRouteId: config.warpRouteId,
      },
      'Creating RebalancerContextFactory',
    );
    const addresses = await registry.getAddresses();

    // The Sealevel warp adapters require the Mailbox address, so we
    // get mailboxes for all chains and merge them with the chain metadata.
    const mailboxes = objMap(addresses, (_, { mailbox }) => ({ mailbox }));

    // Create MultiProtocolProvider (convert from MultiProvider if not provided)
    const mpp =
      multiProtocolProvider ??
      MultiProtocolProvider.fromMultiProvider(multiProvider);
    const provider = mpp.extendChainMetadata(mailboxes);

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

    logger.debug(
      {
        warpRouteId: config.warpRouteId,
      },
      'RebalancerContextFactory created successfully',
    );
    return new RebalancerContextFactory(
      config,
      warpCore,
      tokensByChainName,
      multiProvider,
      registry,
      logger,
    );
  }

  public getWarpCore(): WarpCore {
    return this.warpCore;
  }

  public getTokenForChain(chainName: string): Token | undefined {
    return this.tokensByChainName[chainName];
  }

  public async createMetrics(coingeckoApiKey?: string): Promise<Metrics> {
    this.logger.debug(
      { warpRouteId: this.config.warpRouteId },
      'Creating Metrics',
    );
    const tokenPriceGetter = PriceGetter.create(
      this.multiProvider.metadata,
      this.logger,
      coingeckoApiKey,
    );
    const warpDeployConfig = await this.registry.getWarpDeployConfig(
      this.config.warpRouteId,
    );

    return new Metrics(
      tokenPriceGetter,
      warpDeployConfig,
      this.warpCore,
      this.config.warpRouteId,
      this.logger,
    );
  }

  public createMonitor(checkFrequency: number): Monitor {
    this.logger.debug(
      {
        warpRouteId: this.config.warpRouteId,
        checkFrequency: checkFrequency,
      },
      'Creating Monitor',
    );
    return new Monitor(checkFrequency, this.warpCore, this.logger);
  }

  public async createStrategy(metrics?: Metrics): Promise<IStrategy> {
    this.logger.debug(
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
      this.logger,
      metrics,
    );
  }

  public createRebalancer(metrics?: Metrics): IRebalancer {
    this.logger.debug(
      { warpRouteId: this.config.warpRouteId },
      'Creating Rebalancer',
    );

    // Build chain config from strategy (supports both single and composite strategies)
    const chainNames = getStrategyChainNames(this.config.strategyConfig);
    const chainsConfig: ChainMap<{
      bridge: string;
      bridgeMinAcceptedAmount: string | number;
      bridgeIsWarp: boolean;
      override?: Record<
        string,
        {
          bridge?: string;
          bridgeLockTime?: number;
          bridgeMinAcceptedAmount?: string | number;
          bridgeIsWarp?: boolean;
        }
      >;
    }> = {};

    for (const chainName of chainNames) {
      const cfg = getStrategyChainConfig(this.config.strategyConfig, chainName);
      if (cfg) {
        chainsConfig[chainName] = {
          bridge: cfg.bridge,
          bridgeMinAcceptedAmount: cfg.bridgeMinAcceptedAmount ?? 0,
          bridgeIsWarp: cfg.bridgeIsWarp ?? false,
          override: cfg.override,
        };
      }
    }

    const rebalancer = new Rebalancer(
      chainsConfig,
      this.warpCore,
      this.multiProvider.metadata,
      this.tokensByChainName,
      this.multiProvider,
      this.logger,
      metrics,
    );

    // Wrap with semaphore for concurrency control
    const withSemaphore = new WithSemaphore(
      this.config,
      rebalancer,
      this.logger,
    );

    return withSemaphore;
  }

  public createMessageTracker(
    explorerUrl: string = DEFAULT_EXPLORER_URL,
  ): MessageTracker {
    // Get router addresses from warp tokens
    const routerAddresses: ChainMap<string> = {};
    for (const token of this.warpCore.tokens) {
      if (token.addressOrDenom) {
        routerAddresses[token.chainName] = token.addressOrDenom;
      }
    }

    // Get bridge addresses from strategy config (supports both single and composite strategies)
    const chainNames = getStrategyChainNames(this.config.strategyConfig);
    const bridgeAddresses: ChainMap<string> = {};
    for (const chain of chainNames) {
      const chainConfig = getStrategyChainConfig(
        this.config.strategyConfig,
        chain,
      );
      if (chainConfig?.bridge) {
        bridgeAddresses[chain] = chainConfig.bridge;
      }
    }

    // Get domain IDs from multiProvider metadata
    const domainIds: ChainMap<number> = {};
    for (const chain of chainNames) {
      const metadata = this.multiProvider.getChainMetadata(chain);
      if (metadata?.domainId !== undefined) {
        domainIds[chain] = metadata.domainId;
      }
    }

    this.logger.debug(
      {
        explorerUrl,
        routerCount: Object.keys(routerAddresses).length,
        bridgeCount: Object.keys(bridgeAddresses).length,
        domainCount: Object.keys(domainIds).length,
      },
      'Creating MessageTracker',
    );

    return new MessageTracker(
      {
        explorerUrl,
        routerAddresses,
        bridgeAddresses,
        domainIds,
      },
      this.logger,
    );
  }

  private async getInitialTotalCollateral(): Promise<bigint> {
    let initialTotalCollateral = 0n;

    const chainNames = new Set(
      getStrategyChainNames(this.config.strategyConfig),
    );

    await Promise.all(
      this.warpCore.tokens.map(async (token) => {
        if (
          isCollateralizedTokenEligibleForRebalancing(token) &&
          chainNames.has(token.chainName)
        ) {
          const adapter = token.getHypAdapter(this.warpCore.multiProvider);
          const bridgedSupply = await adapter.getBridgedSupply();
          initialTotalCollateral += bridgedSupply ?? 0n;
        }
      }),
    );

    return initialTotalCollateral;
  }
}
