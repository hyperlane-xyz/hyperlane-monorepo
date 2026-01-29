import { type Logger } from 'pino';

import { IRegistry } from '@hyperlane-xyz/registry';
import {
  type ChainMap,
  HyperlaneCore,
  MultiProtocolProvider,
  MultiProvider,
  type Token,
  WarpCore,
} from '@hyperlane-xyz/sdk';
import { objMap, toWei } from '@hyperlane-xyz/utils';

import { LiFiBridge } from '../bridges/LiFiBridge.js';
import { type RebalancerConfig } from '../config/RebalancerConfig.js';
import {
  ExecutionType,
  getAllBridges,
  getStrategyChainConfig,
  getStrategyChainNames,
} from '../config/types.js';
import { InventoryRebalancer } from '../core/InventoryRebalancer.js';
import { Rebalancer } from '../core/Rebalancer.js';
import type { IExternalBridge } from '../interfaces/IExternalBridge.js';
import type { IInventoryMonitor } from '../interfaces/IInventoryMonitor.js';
import type { IInventoryRebalancer } from '../interfaces/IInventoryRebalancer.js';
import type { IRebalancer } from '../interfaces/IRebalancer.js';
import type { IStrategy } from '../interfaces/IStrategy.js';
import { Metrics } from '../metrics/Metrics.js';
import { PriceGetter } from '../metrics/PriceGetter.js';
import { InventoryMonitor } from '../monitor/InventoryMonitor.js';
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
   * @param multiProvider - MultiProvider instance (for movable collateral operations)
   * @param inventoryMultiProvider - MultiProvider instance for inventory operations (optional)
   * @param registry - IRegistry instance
   * @param logger - Logger instance
   */
  private constructor(
    private readonly config: RebalancerConfig,
    private readonly warpCore: WarpCore,
    private readonly tokensByChainName: ChainMap<Token>,
    private readonly multiProvider: MultiProvider,
    private readonly inventoryMultiProvider: MultiProvider | undefined,
    private readonly registry: IRegistry,
    private readonly logger: Logger,
  ) {}

  /**
   * @param config - The rebalancer config
   * @param multiProvider - MultiProvider instance (for movable collateral operations)
   * @param inventoryMultiProvider - MultiProvider instance for inventory operations (optional)
   * @param multiProtocolProvider - MultiProtocolProvider instance (optional, created from multiProvider if not provided)
   * @param registry - IRegistry instance
   * @param logger - Logger instance
   */
  public static async create(
    config: RebalancerConfig,
    multiProvider: MultiProvider,
    inventoryMultiProvider: MultiProvider | undefined,
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
      inventoryMultiProvider,
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

    // Build minAmountsByChain from chain configs
    const chainNames = getStrategyChainNames(this.config.strategyConfig);
    const minAmountsByChain: ChainMap<bigint> = {};

    for (const chainName of chainNames) {
      const chainConfig = getStrategyChainConfig(
        this.config.strategyConfig,
        chainName,
      );
      if (chainConfig?.bridgeMinAcceptedAmount) {
        const token = this.tokensByChainName[chainName];
        const decimals = token?.decimals ?? 18;
        minAmountsByChain[chainName] = BigInt(
          toWei(chainConfig.bridgeMinAcceptedAmount, decimals),
        );
      }
    }

    this.logger.debug(
      {
        minAmountsByChain: Object.fromEntries(
          Object.entries(minAmountsByChain).map(([k, v]) => [k, v.toString()]),
        ),
      },
      'Built minimum amounts by chain for strategy',
    );

    return StrategyFactory.createStrategy(
      this.config.strategyConfig,
      this.tokensByChainName,
      await this.getInitialTotalCollateral(),
      this.logger,
      metrics,
      minAmountsByChain,
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

    // 3. Get HyperlaneCore from registry
    const addresses = await this.registry.getAddresses();
    const hyperlaneCore = HyperlaneCore.fromAddressesMap(
      addresses,
      this.multiProvider,
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
      inventorySignerAddress: this.config.inventorySigner,
    };

    // 6. Create ActionTracker
    const tracker = new ActionTracker(
      transferStore,
      intentStore,
      actionStore,
      explorerClient,
      hyperlaneCore,
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

  /**
   * Creates inventory components for inventory-based rebalancing.
   * Returns null if inventory config is not available.
   *
   * @param actionTracker - ActionTracker instance for tracking inventory actions
   */
  public async createInventoryComponents(
    actionTracker: IActionTracker,
  ): Promise<{
    inventoryMonitor: IInventoryMonitor;
    inventoryRebalancer: IInventoryRebalancer;
    bridge: IExternalBridge;
  } | null> {
    const { inventorySigner, lifiIntegrator } = this.config;

    // Check if inventory config is available
    if (!inventorySigner || !lifiIntegrator) {
      this.logger.debug(
        'Inventory config not available, skipping inventory components creation',
      );
      return null;
    }

    this.logger.debug(
      { warpRouteId: this.config.warpRouteId, inventorySigner },
      'Creating inventory components',
    );

    // 1. Identify inventory chains from strategy config
    const inventoryChains = getStrategyChainNames(
      this.config.strategyConfig,
    ).filter((chainName) => {
      const chainConfig = getStrategyChainConfig(
        this.config.strategyConfig,
        chainName,
      );
      return chainConfig?.executionType === ExecutionType.Inventory;
    });

    if (inventoryChains.length === 0) {
      this.logger.debug('No inventory chains configured');
      return null;
    }

    // 2. Create LiFiBridge
    const bridge = new LiFiBridge(
      {
        integrator: lifiIntegrator,
      },
      this.logger,
    );

    // 3. Create InventoryMonitor
    const inventoryMonitor = new InventoryMonitor(
      {
        inventorySigner,
        inventoryChains,
      },
      this.warpCore,
      actionTracker,
      this.logger,
    );

    // 4. Create InventoryRebalancer
    // Use inventoryMultiProvider for inventory operations if available, otherwise fall back to multiProvider
    const inventoryRebalancer = new InventoryRebalancer(
      {
        inventorySigner,
        inventoryMultiProvider: this.inventoryMultiProvider,
        inventoryChains,
      },
      inventoryMonitor,
      actionTracker,
      bridge,
      this.warpCore,
      this.multiProvider,
      this.logger,
    );

    this.logger.info(
      {
        inventoryChains,
        inventorySigner,
      },
      'Inventory components created successfully',
    );

    return { inventoryMonitor, inventoryRebalancer, bridge };
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
