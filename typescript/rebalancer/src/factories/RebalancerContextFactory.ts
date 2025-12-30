import { Logger } from 'pino';

import { IRegistry } from '@hyperlane-xyz/registry';
import {
  type ChainMap,
  MultiProtocolProvider,
  MultiProvider,
  RebalancerStrategyOptions,
  type Token,
  WarpCore,
} from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

import { RebalancerConfig } from '../config/RebalancerConfig.js';
import { Rebalancer } from '../core/Rebalancer.js';
import { WithSemaphore } from '../core/WithSemaphore.js';
import type { IRebalancer } from '../interfaces/IRebalancer.js';
import type { IStrategy } from '../interfaces/IStrategy.js';
import { Metrics } from '../metrics/Metrics.js';
import { PriceGetter } from '../metrics/PriceGetter.js';
import { Monitor } from '../monitor/Monitor.js';
import { StrategyFactory } from '../strategy/StrategyFactory.js';
import { MessageTracker, type MessageTrackerConfig } from '../tracker/index.js';
import { isCollateralizedTokenEligibleForRebalancing } from '../utils/index.js';

export class RebalancerContextFactory {
  /**
   * @param config - The rebalancer config
   * @param warpCore - An instance of `WarpCore` configured for the specified `warpRouteId`.
   * @param tokensByChainName - A map of chain->token to ease the lookup of token by chain
   * @param multiProvider - MultiProvider instance
   * @param registry - IRegistry instance
   * @param mailboxAddresses - Mailbox addresses by chain
   * @param logger - Logger instance
   */
  private constructor(
    private readonly config: RebalancerConfig,
    private readonly warpCore: WarpCore,
    private readonly tokensByChainName: ChainMap<Token>,
    private readonly multiProvider: MultiProvider,
    private readonly registry: IRegistry,
    private readonly mailboxAddresses: ChainMap<string>,
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
    const mailboxAddresses: ChainMap<string> = objMap(
      addresses,
      (_, { mailbox }) => mailbox,
    );

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
      mailboxAddresses,
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

    // Build bridge config from strategy, handling composite strategies
    const bridgeConfig = this.buildBridgeConfig();

    const rebalancer = new Rebalancer(
      bridgeConfig,
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

  private async getInitialTotalCollateral(): Promise<bigint> {
    let initialTotalCollateral = 0n;

    const chainNames = this.getConfiguredChains();

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

  /**
   * Create a MessageTracker for tracking inflight messages
   * @param explorerUrl - The Explorer GraphQL API URL
   */
  public createMessageTracker(explorerUrl: string): MessageTracker {
    this.logger.debug(
      { warpRouteId: this.config.warpRouteId, explorerUrl },
      'Creating MessageTracker',
    );

    const config = this.buildMessageTrackerConfig(explorerUrl);
    return new MessageTracker(config, this.multiProvider, this.logger);
  }

  /**
   * Build MessageTracker configuration from rebalancer config
   */
  private buildMessageTrackerConfig(explorerUrl: string): MessageTrackerConfig {
    const routerAddresses: ChainMap<string> = {};
    const bridgeAddresses: ChainMap<string> = {};
    const domainIds: ChainMap<number> = {};

    // Get router addresses from warp core tokens
    for (const token of this.warpCore.tokens) {
      if (token.addressOrDenom) {
        routerAddresses[token.chainName] = token.addressOrDenom;
      }

      // Get domain ID from chain metadata
      const chainMetadata = this.multiProvider.getChainMetadata(
        token.chainName,
      );
      if (chainMetadata?.domainId) {
        domainIds[token.chainName] = chainMetadata.domainId;
      }
    }

    // Get bridge addresses from strategy config
    const strategyConfig = this.config.strategyConfig;

    if (
      strategyConfig.rebalanceStrategy === RebalancerStrategyOptions.Composite
    ) {
      // For composite strategies, collect bridges from all sub-strategies
      for (const subStrategy of (strategyConfig as any).strategies) {
        for (const [chainName, chainConfig] of Object.entries(
          subStrategy.chains,
        )) {
          if ((chainConfig as any).bridge) {
            bridgeAddresses[chainName] = (chainConfig as any).bridge;
          }
        }
      }
    } else {
      // For single strategies
      for (const [chainName, chainConfig] of Object.entries(
        strategyConfig.chains,
      )) {
        if ((chainConfig as any).bridge) {
          bridgeAddresses[chainName] = (chainConfig as any).bridge;
        }
      }
    }

    // Get rebalancer address (signer address)
    const signerAddress =
      this.multiProvider
        .getSigner(Object.keys(routerAddresses)[0])
        ?.getAddress?.() ?? '';

    return {
      explorerUrl,
      routerAddresses,
      bridgeAddresses,
      domainIds,
      mailboxAddresses: this.mailboxAddresses,
      rebalancerAddress: signerAddress instanceof Promise ? '' : signerAddress,
    };
  }

  /**
   * Build bridge config from strategy, handling composite strategies
   */
  private buildBridgeConfig(): ChainMap<{
    bridge: string;
    bridgeMinAcceptedAmount: string | number;
    bridgeIsWarp: boolean;
    override?: Record<string, any>;
  }> {
    const strategyConfig = this.config.strategyConfig;
    const result: ChainMap<{
      bridge: string;
      bridgeMinAcceptedAmount: string | number;
      bridgeIsWarp: boolean;
      override?: Record<string, any>;
    }> = {};

    if (
      strategyConfig.rebalanceStrategy === RebalancerStrategyOptions.Composite
    ) {
      // Collect bridge configs from all sub-strategies
      for (const subStrategy of (strategyConfig as any).strategies) {
        for (const [chainName, chainConfig] of Object.entries(
          subStrategy.chains,
        )) {
          const config = chainConfig as any;
          // Use first encountered config for each chain
          if (!result[chainName]) {
            result[chainName] = {
              bridge: config.bridge,
              bridgeMinAcceptedAmount: config.bridgeMinAcceptedAmount ?? 0,
              bridgeIsWarp: config.bridgeIsWarp ?? false,
              override: config.override,
            };
          }
        }
      }
      return result;
    }

    // Single strategy
    return objMap(strategyConfig.chains, (_, v) => ({
      bridge: v.bridge,
      bridgeMinAcceptedAmount: v.bridgeMinAcceptedAmount ?? 0,
      bridgeIsWarp: v.bridgeIsWarp ?? false,
      override: v.override,
    }));
  }

  /**
   * Get set of configured chain names, handling both single and composite strategies
   */
  private getConfiguredChains(): Set<string> {
    const strategyConfig = this.config.strategyConfig;

    if (
      strategyConfig.rebalanceStrategy === RebalancerStrategyOptions.Composite
    ) {
      const chains = new Set<string>();
      for (const subStrategy of (strategyConfig as any).strategies) {
        for (const chain of Object.keys(subStrategy.chains)) {
          chains.add(chain);
        }
      }
      return chains;
    }

    return new Set(Object.keys(strategyConfig.chains));
  }
}
