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
  type WarpCoreConfig,
} from '@hyperlane-xyz/sdk';
import { objMap, toWei } from '@hyperlane-xyz/utils';

import { LiFiBridge } from '../bridges/LiFiBridge.js';
import { type RebalancerConfig } from '../config/RebalancerConfig.js';
import {
  ExecutionType,
  ExternalBridgeType,
  getAllBridges,
  getStrategyChainConfig,
  getStrategyChainNames,
} from '../config/types.js';
import { InventoryRebalancer } from '../core/InventoryRebalancer.js';
import { Rebalancer } from '../core/Rebalancer.js';
import { RebalancerOrchestrator } from '../core/RebalancerOrchestrator.js';
import type { ExternalBridgeRegistry } from '../interfaces/IExternalBridge.js';
import type { IRebalancer } from '../interfaces/IRebalancer.js';
import type { IStrategy } from '../interfaces/IStrategy.js';
import { Metrics } from '../metrics/Metrics.js';
import { PriceGetter } from '../metrics/PriceGetter.js';
import { type InventoryMonitorConfig, Monitor } from '../monitor/Monitor.js';
import { StrategyFactory } from '../strategy/StrategyFactory.js';
import {
  ActionTracker,
  type ActionTrackerConfig,
} from '../tracking/ActionTracker.js';
import type { IActionTracker } from '../tracking/IActionTracker.js';
import { InflightContextAdapter } from '../tracking/InflightContextAdapter.js';
import { InMemoryStore } from '../tracking/store/index.js';
import type {
  RebalanceAction,
  RebalanceActionStatus,
  RebalanceIntent,
  RebalanceIntentStatus,
  Transfer,
  TransferStatus,
} from '../tracking/types.js';
import {
  ExplorerClient,
  type IExplorerClient,
} from '../utils/ExplorerClient.js';
import { isCollateralizedTokenEligibleForRebalancing } from '../utils/tokenUtils.js';

const DEFAULT_EXPLORER_URL =
  process.env.EXPLORER_API_URL || 'https://explorer4.hasura.app/v1/graphql';

export class RebalancerContextFactory {
  /**
   * @param config - The rebalancer config
   * @param warpCore - An instance of `WarpCore` configured for the specified `warpRouteId`.
   * @param tokensByChainName - A map of chain->token to ease the lookup of token by chain
   * @param multiProvider - MultiProvider instance (for movable collateral operations)
   * @param inventoryMultiProvider - MultiProvider instance for inventory operations (optional)
   * @param multiProtocolProvider - MultiProtocolProvider instance (with mailbox metadata)
   * @param registry - IRegistry instance
   * @param logger - Logger instance
   */
  private constructor(
    private readonly config: RebalancerConfig,
    private readonly warpCore: WarpCore,
    private readonly tokensByChainName: ChainMap<Token>,
    private readonly multiProvider: MultiProvider,
    private readonly inventoryMultiProvider: MultiProvider | undefined,
    private readonly multiProtocolProvider: MultiProtocolProvider,
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
    warpCoreConfigOverride?: WarpCoreConfig,
  ): Promise<RebalancerContextFactory> {
    logger.debug(
      {
        warpRouteId: config.warpRouteId,
      },
      'Creating RebalancerContextFactory',
    );

    // TODO: should we pull addressed for chains we care about, i.e those in the warp config
    const addresses = await registry.getAddresses();

    // The Sealevel warp adapters require the Mailbox address, so we
    // get mailboxes for all chains and merge them with the chain metadata.
    const mailboxes = objMap(addresses, (_, { mailbox }) => ({ mailbox }));

    // Fetch warp route config FIRST to get chain list
    const warpCoreConfig =
      warpCoreConfigOverride ??
      (await registry.getWarpRoute(config.warpRouteId));
    if (!warpCoreConfig) {
      throw new Error(
        `Warp route config for ${config.warpRouteId} not found in registry`,
      );
    }

    // Force-initialize providers for all warp route chains
    // This ensures fromMultiProvider() snapshots actual provider instances
    const warpChains = [
      ...new Set(warpCoreConfig.tokens.map((t: any) => t.chainName)),
    ];
    for (const chain of warpChains) {
      multiProvider.getProvider(chain);
    }

    // Create MultiProtocolProvider (convert from MultiProvider if not provided)
    const mpp =
      multiProtocolProvider ??
      MultiProtocolProvider.fromMultiProvider(multiProvider);
    const extendedMultiProtocolProvider = mpp.extendChainMetadata(mailboxes);

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
      inventoryMultiProvider,
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

  public createMonitor(
    checkFrequency: number,
    inventoryConfig?: InventoryMonitorConfig,
  ): Monitor {
    this.logger.debug(
      {
        warpRouteId: this.config.warpRouteId,
        checkFrequency: checkFrequency,
      },
      'Creating Monitor',
    );
    return new Monitor(
      checkFrequency,
      this.warpCore,
      this.logger,
      inventoryConfig,
    );
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

  private createMovableCollateralRebalancer(
    actionTracker: IActionTracker,
    metrics?: Metrics,
  ): IRebalancer {
    this.logger.debug(
      { warpRouteId: this.config.warpRouteId },
      'Creating Rebalancer',
    );

    const rebalancer = new Rebalancer(
      this.warpCore,
      this.multiProvider.metadata,
      this.tokensByChainName,
      this.multiProvider,
      actionTracker,
      this.logger,
      metrics,
    );

    return rebalancer;
  }

  public async createActionTracker(
    explorerUrlOrClient: string | IExplorerClient = DEFAULT_EXPLORER_URL,
  ): Promise<{
    tracker: IActionTracker;
    adapter: InflightContextAdapter;
  }> {
    this.logger.debug(
      { warpRouteId: this.config.warpRouteId },
      'Creating ActionTracker',
    );

    const transferStore = new InMemoryStore<Transfer, TransferStatus>();
    const intentStore = new InMemoryStore<
      RebalanceIntent,
      RebalanceIntentStatus
    >();
    const actionStore = new InMemoryStore<
      RebalanceAction,
      RebalanceActionStatus
    >();

    const explorerClient =
      typeof explorerUrlOrClient === 'string'
        ? new ExplorerClient(explorerUrlOrClient)
        : explorerUrlOrClient;

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
      inventorySignerAddress: this.config.inventorySigner,
      intentTTL: this.config.intentTTL,
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

  /**
   * Creates inventory components for inventory-based rebalancing.
   * Returns null if inventory config is not available.
   *
   * @param actionTracker - ActionTracker instance for tracking inventory actions
   * @param externalBridgeRegistryOverride - Optional override for external bridge registry (for testing)
   */
  private async createInventoryRebalancerAndConfig(
    actionTracker: IActionTracker,
    externalBridgeRegistryOverride?: Partial<ExternalBridgeRegistry>,
  ): Promise<{
    inventoryRebalancer: IRebalancer;
    externalBridgeRegistry: Partial<ExternalBridgeRegistry>;
    inventoryConfig: InventoryMonitorConfig;
  } | null> {
    const { inventorySigner, externalBridges } = this.config;

    if (!inventorySigner) {
      this.logger.debug(
        'Inventory config not available, skipping inventory components creation',
      );
      return null;
    }

    this.logger.debug(
      { warpRouteId: this.config.warpRouteId, inventorySigner },
      'Creating inventory components',
    );

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

    // Use override if provided, skip the bridge registry build
    if (externalBridgeRegistryOverride !== undefined) {
      if (Object.keys(externalBridgeRegistryOverride).length === 0) {
        this.logger.debug(
          'No external bridges in override registry, skipping inventory components',
        );
        return null;
      }
      const inventoryConfig: InventoryMonitorConfig = {
        inventoryAddress: inventorySigner,
        chains: inventoryChains,
      };
      const inventoryRebalancer = new InventoryRebalancer(
        {
          inventorySigner,
          inventoryMultiProvider: this.inventoryMultiProvider,
          inventoryChains,
        },
        actionTracker,
        externalBridgeRegistryOverride,
        this.warpCore,
        this.multiProvider,
        this.logger,
      );
      return {
        inventoryRebalancer,
        externalBridgeRegistry: externalBridgeRegistryOverride,
        inventoryConfig,
      };
    }

    // Build registry dynamically from ExternalBridgeType enum
    const externalBridgeRegistry: Partial<ExternalBridgeRegistry> = {};

    for (const bridgeType of Object.values(ExternalBridgeType)) {
      switch (bridgeType) {
        case ExternalBridgeType.LiFi: {
          const lifiConfig = externalBridges?.lifi;
          if (lifiConfig?.integrator) {
            externalBridgeRegistry[ExternalBridgeType.LiFi] = new LiFiBridge(
              {
                integrator: lifiConfig.integrator,
                defaultSlippage: lifiConfig.defaultSlippage,
                chainMetadata: this.multiProvider.metadata,
              },
              this.logger,
            );
          }
          break;
        }
        default: {
          // Exhaustive check - TypeScript will error if new enum value added
          const _exhaustive: never = bridgeType;
          throw new Error(`Unknown bridge type: ${_exhaustive}`);
        }
      }
    }

    if (Object.keys(externalBridgeRegistry).length === 0) {
      this.logger.debug(
        'No external bridges configured, skipping inventory components',
      );
      return null;
    }

    // 3. Build inventory config
    const inventoryConfig: InventoryMonitorConfig = {
      inventoryAddress: inventorySigner,
      chains: inventoryChains,
    };

    // 4. Create InventoryRebalancer
    // Use inventoryMultiProvider for inventory operations if available, otherwise fall back to multiProvider
    const inventoryRebalancer = new InventoryRebalancer(
      {
        inventorySigner,
        inventoryMultiProvider: this.inventoryMultiProvider,
        inventoryChains,
      },
      actionTracker,
      externalBridgeRegistry,
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

    return { inventoryRebalancer, externalBridgeRegistry, inventoryConfig };
  }

  /**
   * Creates all rebalancers based on config execution types.
   * Returns an array of rebalancers (movableCollateral and/or inventory)
   * along with metadata needed for monitor and orchestrator.
   *
   * @param actionTracker - ActionTracker instance for tracking actions
   * @param metrics - Optional Metrics instance
   * @param externalBridgeRegistryOverride - Optional override for external bridge registry (for testing)
   */
  public async createRebalancers(
    actionTracker: IActionTracker,
    metrics?: Metrics,
    externalBridgeRegistryOverride?: Partial<ExternalBridgeRegistry>,
  ): Promise<{
    rebalancers: IRebalancer[];
    externalBridgeRegistry: Partial<ExternalBridgeRegistry>;
    inventoryConfig?: InventoryMonitorConfig;
  }> {
    const rebalancers: IRebalancer[] = [];
    let externalBridgeRegistry: Partial<ExternalBridgeRegistry> = {};
    let inventoryConfig: InventoryMonitorConfig | undefined;

    // Check if any chains use movableCollateral execution type
    const hasMovableCollateral = this.hasMovableCollateralChains();
    if (hasMovableCollateral) {
      const rebalancer = this.createMovableCollateralRebalancer(
        actionTracker,
        metrics,
      );
      rebalancers.push(rebalancer);
    }

    // Check if any chains use inventory execution type
    const inventoryComponents = await this.createInventoryRebalancerAndConfig(
      actionTracker,
      externalBridgeRegistryOverride,
    );
    if (inventoryComponents) {
      rebalancers.push(inventoryComponents.inventoryRebalancer);
      externalBridgeRegistry = inventoryComponents.externalBridgeRegistry;
      inventoryConfig = inventoryComponents.inventoryConfig;
    }

    return { rebalancers, externalBridgeRegistry, inventoryConfig };
  }

  /**
   * Creates a RebalancerOrchestrator with all required dependencies.
   */
  public createOrchestrator(options: {
    strategy: IStrategy;
    actionTracker: IActionTracker;
    inflightContextAdapter: InflightContextAdapter;
    rebalancers: IRebalancer[];
    externalBridgeRegistry: Partial<ExternalBridgeRegistry>;
    metrics?: Metrics;
  }): RebalancerOrchestrator {
    this.logger.debug(
      { warpRouteId: this.config.warpRouteId },
      'Creating RebalancerOrchestrator',
    );

    return new RebalancerOrchestrator({
      strategy: options.strategy,
      actionTracker: options.actionTracker,
      inflightContextAdapter: options.inflightContextAdapter,
      rebalancerConfig: this.config,
      logger: this.logger,
      rebalancers: options.rebalancers,
      externalBridgeRegistry: options.externalBridgeRegistry,
      metrics: options.metrics,
    });
  }

  private hasMovableCollateralChains(): boolean {
    return getStrategyChainNames(this.config.strategyConfig).some(
      (chainName) => {
        const chainConfig = getStrategyChainConfig(
          this.config.strategyConfig,
          chainName,
        );
        return (
          chainConfig?.executionType === ExecutionType.MovableCollateral ||
          chainConfig?.executionType === undefined
        ); // Default is movableCollateral
      },
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
