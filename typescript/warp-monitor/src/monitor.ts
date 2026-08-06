import { utils as ethersUtils } from 'ethers';

import {
  type TokenPriceGetter,
  getExtraLockboxBalance,
  getExtraLockboxInfo,
  getManagedLockBoxCollateralInfo,
  getSealevelAtaPayerBalance,
  getTokenBridgedBalance,
  getXERC20Info,
  startMetricsServer,
} from '@hyperlane-xyz/metrics';
import type { IRegistry } from '@hyperlane-xyz/registry';
import {
  type ChainMap,
  type ChainMetadata,
  CoinGeckoTokenPriceGetter,
  MultiProtocolProvider,
  Token,
  TokenType,
  WarpCore,
  type WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import {
  ProtocolType,
  applyRpcUrlOverridesFromEnv,
  objMap,
  objMerge,
  sleep,
  tryFn,
} from '@hyperlane-xyz/utils';

import {
  ExplorerPendingTransfersClient,
  type RouterNodeMetadata,
} from './explorer.js';
import { DEFAULT_EXPLORER_QUERY_LIMIT } from './constants.js';
import {
  type InventoryBalanceMetric,
  type PendingDestinationMetric,
  type ProjectedDeficitMetric,
  metricsRegister,
  replaceInventoryBalanceMetricsForRoute,
  replacePendingDestinationMetricsForRoute,
  updateManagedLockboxBalanceMetrics,
  updateNativeWalletBalanceMetrics,
  updateTokenBalanceMetrics,
  updateXERC20LimitsMetrics,
} from './metrics.js';
import type { WarpMonitorConfig } from './types.js';
import { getLogger, setLoggerBindings } from './utils.js';

// Prices are refreshed once per cycle by prefetchPrices, so cache entries must
// stay fresh for at least a full cycle (which can span several minutes across
// the whole fleet) to keep every per-token lookup a cache hit. One hour is
// comfortably longer than any cycle while still bounding staleness.
const PRICE_CACHE_EXPIRY_SECONDS = 60 * 60;

type RouterCollateralSnapshot = {
  nodeId: string;
  routerCollateralBaseUnits: bigint;
  token: Token;
};

type PendingDestinationAggregate = {
  amountBaseUnits: bigint;
  count: number;
  oldestPendingSeconds: number;
};

/**
 * Chain- and price-level state that is expensive to build and is identical for
 * every warp route. Built once and shared across all routes so the centralized
 * monitor does not re-derive a MultiProtocolProvider or price getter per route.
 */
export type SharedMonitorContext = {
  multiProtocolProvider: MultiProtocolProvider;
  chainMetadata: ChainMap<ChainMetadata>;
  priceGetter: TokenPriceGetter;
  // Warms the shared price cache for the given routes in a single batched pass
  // so per-token price lookups are served from cache instead of each issuing
  // its own CoinGecko request (which, at fleet scale from one pod, gets rate
  // limited). Call once per cycle before iterating tokens.
  prefetchPrices: (routes: RouteRuntime[]) => Promise<void>;
};

/**
 * Per-route configuration used to build a {@link RouteRuntime}.
 */
export type RouteMonitorConfig = {
  warpRouteId: string;
  explorerApiUrl?: string;
  explorerQueryLimit?: number;
  inventoryAddress?: string;
  // When true, the shared balance metrics (token balance, collateral value,
  // value at risk, xERC20 limits, native/ATA wallet balance, managed lockbox
  // balance) are NOT emitted for this route because another workload (a
  // rebalancer) already emits them. Monitor-only metrics (pending destination,
  // projected deficit, inventory) are always emitted.
  skipSharedBalanceMetrics?: boolean;
};

/**
 * Fully-resolved per-route runtime: warp core, deploy config, router nodes and
 * explorer client. Cheap to hold; one per monitored route.
 */
export type RouteRuntime = {
  warpRouteId: string;
  warpCore: WarpCore;
  warpDeployConfig: WarpRouteDeployConfig | null;
  routerNodes: RouterNodeMetadata[];
  pendingTransfersClient?: ExplorerPendingTransfersClient;
  explorerQueryLimit: number;
  inventoryAddress?: string;
  skipSharedBalanceMetrics: boolean;
};

/**
 * Build the chain/price context shared by every monitored route.
 */
export async function buildSharedContext(
  registry: IRegistry,
  coingeckoApiKey?: string,
): Promise<SharedMonitorContext> {
  const logger = getLogger();

  // Get chain metadata and addresses from registry
  const chainMetadata = await registry.getMetadata();
  const chainAddresses = await registry.getAddresses();
  const overriddenChains = applyRpcUrlOverridesFromEnv(chainMetadata);
  if (overriddenChains.length > 0) {
    logger.info(
      { chains: overriddenChains, count: overriddenChains.length },
      'Applied RPC overrides from environment variables',
    );
  }

  // The Sealevel warp adapters require the Mailbox address, so we
  // get mailboxes for all chains and merge them with the chain metadata.
  const mailboxes = objMap(chainAddresses, (_, { mailbox }) => ({
    mailbox,
  }));
  const multiProtocolProvider = new MultiProtocolProvider(
    objMerge(chainMetadata, mailboxes),
  );

  if (!coingeckoApiKey) {
    logger.warn(
      'No CoinGecko API key provided, using public tier (rate limited)',
    );
  }
  const tokenPriceGetter = new CoinGeckoTokenPriceGetter({
    chainMetadata,
    apiKey: coingeckoApiKey,
    // Prices are refreshed once per cycle by prefetchPrices; keep cache entries
    // fresh long enough that every per-token lookup within a (potentially
    // multi-minute) cycle is served from cache rather than triggering its own
    // request.
    expirySeconds: PRICE_CACHE_EXPIRY_SECONDS,
  });

  // Per-token lookups read only from the cache (warmed by prefetchPrices); a
  // miss returns undefined rather than issuing a request, so a single pod cannot
  // burst one CoinGecko call per token and get rate limited.
  const priceGetter: TokenPriceGetter = {
    tryGetTokenPrice: async (token: Token) =>
      getCachedTokenPrice(token, tokenPriceGetter),
  };

  const prefetchPrices = async (routes: RouteRuntime[]): Promise<void> => {
    const ids = collectCoinGeckoIds(routes);
    if (ids.length === 0) return;
    await tokenPriceGetter.prefetchTokenPrices(ids);
  };

  return { multiProtocolProvider, chainMetadata, priceGetter, prefetchPrices };
}

/**
 * Resolve a single route's runtime from the registry using the shared context.
 */
export async function buildRouteRuntime(
  ctx: SharedMonitorContext,
  registry: IRegistry,
  config: RouteMonitorConfig,
): Promise<RouteRuntime> {
  const logger = getLogger();

  const warpCoreConfig = await registry.getWarpRoute(config.warpRouteId);
  if (!warpCoreConfig) {
    throw new Error(
      `Warp route config for ${config.warpRouteId} not found in registry`,
    );
  }

  const warpCore = WarpCore.FromConfig(
    ctx.multiProtocolProvider,
    warpCoreConfig,
  );
  const warpDeployConfig = await registry.getWarpDeployConfig(
    config.warpRouteId,
  );
  const routerNodes = buildRouterNodes(warpCore, ctx.chainMetadata);
  const pendingTransfersClient = config.explorerApiUrl
    ? new ExplorerPendingTransfersClient(
        config.explorerApiUrl,
        routerNodes,
        logger,
      )
    : undefined;

  return {
    warpRouteId: config.warpRouteId,
    warpCore,
    warpDeployConfig,
    routerNodes,
    pendingTransfersClient,
    explorerQueryLimit:
      config.explorerQueryLimit ?? DEFAULT_EXPLORER_QUERY_LIMIT,
    inventoryAddress: config.inventoryAddress,
    skipSharedBalanceMetrics: config.skipSharedBalanceMetrics ?? false,
  };
}

/**
 * Run a single monitoring pass for one route: token balance metrics followed by
 * pending/projected-deficit/inventory metrics. Each route atomically replaces
 * only its own pending/inventory series (see
 * {@link replacePendingDestinationMetricsForRoute}), so there is no fleet-wide
 * reset that could wipe sibling routes mid-cycle, and a route that fails to
 * collect leaves its prior series stale rather than zeroing them.
 */
export async function runRouteCycle(
  ctx: SharedMonitorContext,
  route: RouteRuntime,
): Promise<void> {
  const collateralSnapshots = await Promise.all(
    route.warpCore.tokens.map(async (token) =>
      updateTokenMetrics(ctx, route, token),
    ),
  );

  const collateralByNodeId = new Map<string, bigint>();
  for (const snapshot of collateralSnapshots) {
    if (!snapshot) continue;
    collateralByNodeId.set(snapshot.nodeId, snapshot.routerCollateralBaseUnits);
  }

  await updatePendingAndInventoryMetrics(
    route.warpCore,
    route.routerNodes,
    collateralByNodeId,
    route.warpRouteId,
    route.pendingTransfersClient,
    route.explorerQueryLimit,
    route.inventoryAddress,
  );
}

export async function updatePendingAndInventoryMetrics(
  warpCore: WarpCore,
  routerNodes: RouterNodeMetadata[],
  collateralByNodeId: Map<string, bigint>,
  warpRouteId: string,
  pendingTransfersClient?: ExplorerPendingTransfersClient,
  explorerQueryLimit = DEFAULT_EXPLORER_QUERY_LIMIT,
  inventoryAddress?: string,
): Promise<void> {
  const logger = getLogger();
  const now = Date.now();

  const pendingByNodeId = new Map<string, PendingDestinationAggregate>();
  // With no explorer configured, pending data is trivially available and empty
  // (we legitimately report zero pending). Only an actual query FAILURE leaves
  // the flag false, so we skip the replacement below and let the route's prior
  // pending/deficit series go stale instead of publishing confident zeroes
  // that would silence deficit alerting during an explorer outage.
  let pendingDataAvailable = !pendingTransfersClient;
  if (pendingTransfersClient) {
    try {
      const pendingTransfers =
        await pendingTransfersClient.getPendingDestinationTransfers(
          explorerQueryLimit,
        );

      for (const transfer of pendingTransfers) {
        const aggregate = pendingByNodeId.get(transfer.destinationNodeId) ?? {
          amountBaseUnits: 0n,
          count: 0,
          oldestPendingSeconds: 0,
        };

        aggregate.amountBaseUnits += transfer.amountBaseUnits;
        aggregate.count += 1;

        if (transfer.sendOccurredAtMs) {
          const ageSeconds = Math.max(
            0,
            Math.floor((now - transfer.sendOccurredAtMs) / 1000),
          );
          aggregate.oldestPendingSeconds = Math.max(
            aggregate.oldestPendingSeconds,
            ageSeconds,
          );
        }

        pendingByNodeId.set(transfer.destinationNodeId, aggregate);
      }
      pendingDataAvailable = true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        { warpRouteId, error: message },
        'Failed to query explorer pending transfers; leaving prior series stale',
      );
    }
  }

  if (pendingDataAvailable) {
    const pending: PendingDestinationMetric[] = [];
    const projected: ProjectedDeficitMetric[] = [];
    const deficits: Array<{ nodeId: string; projectedDeficit: string }> = [];

    for (const node of routerNodes) {
      const aggregate = pendingByNodeId.get(node.nodeId) ?? {
        amountBaseUnits: 0n,
        count: 0,
        oldestPendingSeconds: 0,
      };

      pending.push({
        warpRouteId,
        nodeId: node.nodeId,
        chainName: node.chainName,
        routerAddress: node.routerAddress,
        tokenAddress: node.tokenAddress,
        tokenSymbol: node.tokenSymbol,
        tokenName: node.tokenName,
        pendingAmount: formatTokenAmount(node.token, aggregate.amountBaseUnits),
        pendingCount: aggregate.count,
        oldestPendingSeconds: aggregate.oldestPendingSeconds,
      });

      if (!node.token.isCollateralized()) {
        continue;
      }

      const routerCollateral = collateralByNodeId.get(node.nodeId) ?? 0n;
      const projectedDeficitBaseUnits =
        aggregate.amountBaseUnits > routerCollateral
          ? aggregate.amountBaseUnits - routerCollateral
          : 0n;

      projected.push({
        warpRouteId,
        nodeId: node.nodeId,
        chainName: node.chainName,
        routerAddress: node.routerAddress,
        tokenAddress: node.tokenAddress,
        tokenSymbol: node.tokenSymbol,
        tokenName: node.tokenName,
        projectedDeficit: formatTokenAmount(
          node.token,
          projectedDeficitBaseUnits,
        ),
      });

      if (projectedDeficitBaseUnits > 0n) {
        deficits.push({
          nodeId: node.nodeId,
          projectedDeficit: projectedDeficitBaseUnits.toString(),
        });
      }
    }

    replacePendingDestinationMetricsForRoute(warpRouteId, pending, projected);

    if (deficits.length > 0) {
      logger.warn(
        {
          warpRouteId,
          deficits,
          deficitNodeCount: deficits.length,
        },
        'Detected projected destination deficits from pending transfers',
      );
    }
  }

  if (!inventoryAddress) return;

  const inventory: InventoryBalanceMetric[] = [];
  await Promise.all(
    routerNodes.map(async (node) => {
      try {
        const adapter = node.token.getAdapter(warpCore.multiProvider);
        const inventoryBalance = await adapter.getBalance(inventoryAddress);

        inventory.push({
          warpRouteId,
          nodeId: node.nodeId,
          chainName: node.chainName,
          routerAddress: node.routerAddress,
          tokenAddress: node.tokenAddress,
          tokenSymbol: node.tokenSymbol,
          tokenName: node.tokenName,
          inventoryAddress,
          inventoryBalance: formatTokenAmount(node.token, inventoryBalance),
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(
          { warpRouteId, nodeId: node.nodeId, error: message },
          `Reading inventory balance for ${node.nodeId} failed`,
        );
      }
    }),
  );

  replaceInventoryBalanceMetricsForRoute(
    warpRouteId,
    inventory,
    new Set(routerNodes.map((node) => node.nodeId)),
  );
}

// Updates the metrics for a single token in a warp route. Always computes the
// router collateral snapshot (needed for projected-deficit, a monitor-only
// metric) but skips emitting shared balance metrics when the route delegates
// those to a rebalancer.
async function updateTokenMetrics(
  ctx: SharedMonitorContext,
  route: RouteRuntime,
  token: Token,
): Promise<RouterCollateralSnapshot | null> {
  const logger = getLogger();
  const { warpCore, warpDeployConfig, warpRouteId, skipSharedBalanceMetrics } =
    route;
  let collateralSnapshot: RouterCollateralSnapshot | null = null;

  const promises = [
    tryFn(
      async () => {
        const bridgedSupply = token.isHypToken()
          ? await token.getHypAdapter(warpCore.multiProvider).getBridgedSupply()
          : undefined;

        if (bridgedSupply !== undefined) {
          collateralSnapshot = {
            nodeId: buildNodeId(token),
            routerCollateralBaseUnits: bridgedSupply,
            token,
          };
        }

        // Shared metric — skip emission (but keep the snapshot above) when a
        // rebalancer owns this route's balance metrics.
        if (skipSharedBalanceMetrics) return;

        const balanceInfo = await getTokenBridgedBalance(
          warpCore,
          token,
          ctx.priceGetter,
          logger,
          bridgedSupply,
        );
        if (!balanceInfo) {
          return;
        }
        updateTokenBalanceMetrics(warpCore, token, balanceInfo, warpRouteId);
      },
      'Getting bridged balance and value',
      logger,
    ),
  ];

  // All remaining metrics in this function are shared balance metrics; skip
  // them entirely when a rebalancer owns them for this route.
  if (skipSharedBalanceMetrics) {
    await Promise.all(promises);
    return collateralSnapshot;
  }

  // For Sealevel collateral and synthetic tokens, there is an
  // "Associated Token Account" (ATA) rent payer that has a balance
  // that's used to pay for rent for the accounts that store user balances.
  // This is necessary if the recipient has never received any tokens before.
  if (token.protocol === ProtocolType.Sealevel && !token.isNative()) {
    promises.push(
      tryFn(
        async () => {
          const balance = await getSealevelAtaPayerBalance(
            warpCore,
            token,
            warpRouteId,
          );
          updateNativeWalletBalanceMetrics(balance);
        },
        'Getting ATA payer balance',
        logger,
      ),
    );
  }

  if (token.isXerc20()) {
    promises.push(
      tryFn(
        async () => {
          const { limits, xERC20Address } = await getXERC20Info(
            warpCore,
            token,
          );
          const routerAddress = token.addressOrDenom;
          updateXERC20LimitsMetrics(
            token,
            limits,
            routerAddress,
            token.standard,
            xERC20Address,
          );
        },
        'Getting xERC20 limits',
        logger,
      ),
    );

    if (!warpDeployConfig) {
      logger.warn(
        { token: token.symbol, chain: token.chainName },
        'Failed to read warp deploy config, skipping extra lockboxes',
      );
      await Promise.all(promises);
      return collateralSnapshot;
    }

    // A ChainMap lookup is typed as always-present, but a deploy config that
    // omits (or differently names) this chain has no entry. Skip the
    // extra-lockbox path rather than letting a TypeError escape and reject the
    // whole route cycle (which would drop its pending/deficit/inventory metrics
    // too, not just the lockbox limits).
    if (!(token.chainName in warpDeployConfig)) {
      logger.warn(
        { token: token.symbol, chain: token.chainName },
        'No warp deploy config entry for chain, skipping extra lockboxes',
      );
      await Promise.all(promises);
      return collateralSnapshot;
    }
    // If the current token is an xERC20, we need to check if there are any extra lockboxes
    const currentTokenDeployConfig = warpDeployConfig[token.chainName];
    if (
      currentTokenDeployConfig.type !== TokenType.XERC20 &&
      currentTokenDeployConfig.type !== TokenType.XERC20Lockbox
    ) {
      logger.error(
        {
          expected: 'XERC20|XERC20Lockbox',
          actual: currentTokenDeployConfig.type,
          token: token.symbol,
          chain: token.chainName,
        },
        'Invalid deploy config type for xERC20 token',
      );
      await Promise.all(promises);
      return collateralSnapshot;
    }

    const extraLockboxes = currentTokenDeployConfig.xERC20?.extraBridges ?? [];

    for (const lockbox of extraLockboxes) {
      promises.push(
        tryFn(
          async () => {
            const { limits, xERC20Address } = await getExtraLockboxInfo(
              warpCore.multiProvider,
              token,
              lockbox.lockbox,
            );

            updateXERC20LimitsMetrics(
              token,
              limits,
              lockbox.lockbox,
              'EvmManagedLockbox',
              xERC20Address,
            );
          },
          'Getting extra lockbox limits',
          logger,
        ),
        tryFn(
          async () => {
            const balance = await getExtraLockboxBalance(
              warpCore.multiProvider,
              token,
              ctx.priceGetter,
              lockbox.lockbox,
              logger,
            );

            if (balance) {
              const { tokenName, tokenAddress } =
                await getManagedLockBoxCollateralInfo(
                  warpCore.multiProvider,
                  token,
                  lockbox.lockbox,
                );

              updateManagedLockboxBalanceMetrics(
                warpCore,
                token.chainName,
                tokenName,
                tokenAddress,
                lockbox.lockbox,
                balance,
                warpRouteId,
              );
            }
          },
          `Updating extra lockbox balance for contract at "${lockbox.lockbox}" on chain ${token.chainName}`,
          logger,
        ),
      );
    }
  }

  await Promise.all(promises);
  return collateralSnapshot;
}

function buildRouterNodes(
  warpCore: WarpCore,
  chainMetadata: ChainMap<ChainMetadata>,
): RouterNodeMetadata[] {
  const nodeByKey = new Map<string, RouterNodeMetadata>();

  for (const token of warpCore.tokens) {
    if (!Object.prototype.hasOwnProperty.call(chainMetadata, token.chainName)) {
      continue;
    }
    const metadata = chainMetadata[token.chainName];
    if (!ethersUtils.isAddress(token.addressOrDenom)) continue;

    const domainId = metadata.domainId;
    const routerAddress = ethersUtils
      .getAddress(token.addressOrDenom)
      .toLowerCase();
    const key = `${domainId}:${routerAddress}`;
    if (nodeByKey.has(key)) continue;

    nodeByKey.set(key, {
      nodeId: buildNodeId(token),
      chainName: token.chainName,
      domainId,
      routerAddress,
      tokenAddress: (
        token.collateralAddressOrDenom ?? token.addressOrDenom
      ).toLowerCase(),
      tokenName: token.name,
      tokenSymbol: token.symbol,
      tokenDecimals: token.decimals,
      tokenScale: token.scale ?? 1,
      token,
    });
  }

  return [...nodeByKey.values()];
}

function buildNodeId(token: Token): string {
  return `${token.symbol}|${token.chainName}|${token.addressOrDenom.toLowerCase()}`;
}

function formatTokenAmount(token: Token, amount: bigint): number {
  return token.amount(amount).getDecimalFormattedAmount();
}

// Reads a token's USD price from the shared cache warmed by prefetchPrices.
// Returns undefined when the token has no CoinGecko ID or no price was cached
// (e.g. CoinGecko does not recognize the id). Never issues a request itself, so
// value metrics for a missing token are simply skipped rather than fanning out
// one CoinGecko call per token.
function getCachedTokenPrice(
  token: Token,
  tokenPriceGetter: CoinGeckoTokenPriceGetter,
): number | undefined {
  const logger = getLogger();
  // We only get a price if the token defines a CoinGecko ID.
  // This way we can ignore values of certain types of collateralized warp routes,
  // e.g. Native warp routes on rollups that have been pre-funded.
  const coinGeckoId = token.coinGeckoId;

  if (!coinGeckoId) {
    logger.warn(
      { token: token.symbol, chain: token.chainName },
      'Missing CoinGecko ID for token',
    );
    return undefined;
  }

  return tokenPriceGetter.getCachedTokenPrice(coinGeckoId);
}

// Distinct CoinGecko IDs across all tokens of the given routes, used to warm the
// price cache in one batched pass per cycle.
export function collectCoinGeckoIds(routes: RouteRuntime[]): string[] {
  const ids = new Set<string>();
  for (const route of routes) {
    for (const token of route.warpCore.tokens) {
      if (token.coinGeckoId) ids.add(token.coinGeckoId);
    }
  }
  return [...ids];
}

export class WarpMonitor {
  private readonly config: WarpMonitorConfig;
  private readonly registry: IRegistry;

  constructor(config: WarpMonitorConfig, registry: IRegistry) {
    this.config = config;
    this.registry = registry;
  }

  async start(): Promise<void> {
    const logger = getLogger();
    const {
      warpRouteId,
      checkFrequency,
      coingeckoApiKey,
      explorerApiUrl,
      explorerQueryLimit,
      inventoryAddress,
    } = this.config;

    setLoggerBindings({
      warp_route: warpRouteId,
    });

    startMetricsServer(metricsRegister);
    logger.info(
      { port: process.env['PROMETHEUS_PORT'] ?? '9090' },
      'Metrics server started',
    );

    const ctx = await buildSharedContext(this.registry, coingeckoApiKey);
    const route = await buildRouteRuntime(ctx, this.registry, {
      warpRouteId,
      explorerApiUrl,
      explorerQueryLimit,
      inventoryAddress,
    });

    logger.info(
      {
        warpRouteId,
        checkFrequency,
        tokenCount: route.warpCore.tokens.length,
        chains: route.warpCore.getTokenChains(),
        crossCollateralNodeCount: route.routerNodes.length,
        explorerEnabled: !!route.pendingTransfersClient,
        inventoryTrackingEnabled: !!inventoryAddress,
      },
      'Starting warp route monitor',
    );

    // Indefinitely loops, updating warp route metrics at the specified
    // frequency. runRouteCycle replaces this route's series in place, so no
    // per-cycle reset is needed.
    for (;;) {
      await tryFn(
        async () => {
          await ctx.prefetchPrices([route]);
          await runRouteCycle(ctx, route);
        },
        'Updating warp route metrics',
        logger,
      );
      await sleep(checkFrequency);
    }
  }
}
