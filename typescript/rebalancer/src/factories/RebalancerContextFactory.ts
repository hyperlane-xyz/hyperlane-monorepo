import { type Logger } from 'pino';

import { IRegistry } from '@hyperlane-xyz/registry';
import {
  type ChainMap,
  type CoreAddresses,
  MultiProtocolCore,
  MultiProtocolProvider,
  MultiProvider,
  type Token,
  WarpCore,
} from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

import { type RebalancerConfig } from '../config/RebalancerConfig.js';
import { getAllBridges, getStrategyChainNames } from '../config/types.js';
import { Rebalancer } from '../core/Rebalancer.js';
import type { IRebalancer } from '../interfaces/IRebalancer.js';
import type { IStrategy } from '../interfaces/IStrategy.js';
import { Metrics } from '../metrics/Metrics.js';
import { PriceGetter } from '../metrics/PriceGetter.js';
import { Monitor } from '../monitor/Monitor.js';
import { StrategyFactory } from '../strategy/StrategyFactory.js';
import {
  ActionTracker,
  type ActionTrackerConfig,
  type IActionTracker,
  InMemoryStore,
  InflightContextAdapter,
  type RebalanceAction,
  type RebalanceActionStatus,
  type RebalanceIntent,
  type RebalanceIntentStatus,
  type Transfer,
  type TransferStatus,
} from '../tracking/index.js';
import { ExplorerClient } from '../utils/ExplorerClient.js';
import { isCollateralizedTokenEligibleForRebalancing } from '../utils/index.js';

const DEFAULT_EXPLORER_URL =
  process.env.EXPLORER_API_URL || 'https://explorer4.hasura.app/v1/graphql';

export class RebalancerContextFactory {
  /**
   * @param config - The rebalancer config
   * @param warpCore - An instance of `WarpCore` configured for the specified `warpRouteId`.
   * @param tokensByChainName - A map of chain->token to ease the lookup of token by chain
   * @param multiProvider - MultiProvider instance
   * @param multiProtocolProvider - MultiProtocolProvider instance (with mailbox metadata)
   * @param registry - IRegistry instance
   * @param logger - Logger instance
   */
  private constructor(
    private readonly config: RebalancerConfig,
    private readonly warpCore: WarpCore,
    private readonly tokensByChainName: ChainMap<Token>,
    private readonly multiProvider: MultiProvider,
    private readonly multiProtocolProvider: MultiProtocolProvider,
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
    const extendedMultiProtocolProvider = mpp.extendChainMetadata(mailboxes);

    const warpCoreConfig = await registry.getWarpRoute(config.warpRouteId);
    if (!warpCoreConfig) {
      throw new Error(
        `Warp route config for ${config.warpRouteId} not found in registry`,
      );
    }
    const warpCore = WarpCore.FromConfig(
      extendedMultiProtocolProvider,
      warpCoreConfig,
    );
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
      extendedMultiProtocolProvider,
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
    const strategyTypes = this.config.strategyConfig.map(
      (s) => s.rebalanceStrategy,
    );
    this.logger.debug(
      {
        warpRouteId: this.config.warpRouteId,
        strategyTypes,
        strategyCount: this.config.strategyConfig.length,
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

    const rebalancer = new Rebalancer(
      this.warpCore,
      this.multiProvider.metadata,
      this.tokensByChainName,
      this.multiProvider,
      this.logger,
      metrics,
    );

    return rebalancer;
  }

  /**
   * Creates an ActionTracker for tracking inflight rebalance actions and user transfers.
   * Returns both the tracker and adapter for use by RebalancerService.
   *
   * @param explorerUrl - Optional explorer URL (defaults to production Hyperlane Explorer)
   */
  public async createActionTracker(
    explorerUrl: string = DEFAULT_EXPLORER_URL,
  ): Promise<{
    tracker: IActionTracker;
    adapter: InflightContextAdapter;
  }> {
    this.logger.debug(
      { warpRouteId: this.config.warpRouteId },
      'Creating ActionTracker',
    );

    // 1. Create in-memory stores
    const transferStore = new InMemoryStore<Transfer, TransferStatus>();
    const intentStore = new InMemoryStore<
      RebalanceIntent,
      RebalanceIntentStatus
    >();
    const actionStore = new InMemoryStore<
      RebalanceAction,
      RebalanceActionStatus
    >();

    // 2. Create ExplorerClient
    const explorerClient = new ExplorerClient(explorerUrl);

    // 3. Get MultiProtocolCore from registry (supports all VM types)
    // Only fetch/validate addresses for warp route chains (not all registry chains)
    const warpRouteChains = new Set(
      this.warpCore.tokens.map((t) => t.chainName),
    );
    const coreAddresses: ChainMap<CoreAddresses> = {};
    for (const chain of warpRouteChains) {
      const addrs = await this.registry.getChainAddresses(chain);
      if (!addrs?.mailbox) {
        throw new Error(
          `Missing mailbox address for chain ${chain} in registry`,
        );
      }
      coreAddresses[chain] = addrs as CoreAddresses;
    }
    const multiProtocolCore = MultiProtocolCore.fromAddressesMap(
      coreAddresses,
      this.multiProtocolProvider,
    );

    // 4. Get rebalancer address from signer
    // Use the first chain in the strategy to get the signer address
    const chainNames = getStrategyChainNames(this.config.strategyConfig);
    if (chainNames.length === 0) {
      throw new Error('No chains configured in strategy');
    }
    const signer = this.multiProvider.getSigner(chainNames[0]);
    const rebalancerAddress = await signer.getAddress();

    const bridges = getAllBridges(this.config.strategyConfig);

    // Build router→domain mapping (source of truth for routers and domains)
    const routersByDomain: Record<number, string> = {};
    for (const token of this.warpCore.tokens) {
      const domain = this.multiProvider.getDomainId(token.chainName);
      routersByDomain[domain] = token.addressOrDenom;
    }

    const trackerConfig: ActionTrackerConfig = {
      routersByDomain,
      bridges,
      rebalancerAddress,
    };

    // 6. Create ActionTracker
    const tracker = new ActionTracker(
      transferStore,
      intentStore,
      actionStore,
      explorerClient,
      multiProtocolCore,
      trackerConfig,
      this.logger,
    );

    // 7. Create InflightContextAdapter
    const adapter = new InflightContextAdapter(tracker, this.multiProvider);

    this.logger.debug(
      {
        warpRouteId: this.config.warpRouteId,
        routerCount: Object.keys(routersByDomain).length,
        bridgeCount: bridges.length,
        domainCount: Object.keys(routersByDomain).length,
      },
      'ActionTracker created successfully',
    );

    return { tracker, adapter };
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
