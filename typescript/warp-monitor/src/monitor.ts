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
import {
  metricsRegister,
  resetInventoryBalanceMetrics,
  resetPendingDestinationMetrics,
  updateInventoryBalanceMetrics,
  updateManagedLockboxBalanceMetrics,
  updateNativeWalletBalanceMetrics,
  updatePendingDestinationMetrics,
  updateProjectedDeficitMetrics,
  updateTokenBalanceMetrics,
  updateXERC20LimitsMetrics,
} from './metrics.js';
import type { WarpMonitorConfig } from './types.js';
import { getLogger, setLoggerBindings } from './utils.js';

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
 * Everything shared across all monitored routes: providers, chain metadata,
 * and the price getter. Built once and reused for every route so the
 * centralized monitor does not rebuild a MultiProtocolProvider per route.
 */
export type WarpMonitorSharedContext = {
  multiProtocolProvider: MultiProtocolProvider;
  chainMetadata: ChainMap<ChainMetadata>;
  priceGetter: TokenPriceGetter;
};

/**
 * Per-route state resolved once at startup. `runRouteCycle` consumes this to
 * emit one full set of metrics for the route.
 */
export type WarpRouteRuntime = {
  warpRouteId: string;
  warpCore: WarpCore;
  warpDeployConfig: WarpRouteDeployConfig | null;
  routerNodes: RouterNodeMetadata[];
  pendingTransfersClient?: ExplorerPendingTransfersClient;
  explorerQueryLimit: number;
  inventoryAddress?: string;
  // When true, the shared balance metrics (token_balance / collateral_value /
  // value_at_risk) are NOT emitted for this route because another workload
  // (e.g. a rebalancer) already owns them. Monitor-only metrics
  // (pending / projected_deficit / inventory / xERC20 / lockbox) still emit.
  skipSharedBalanceMetrics: boolean;
};

export type BuildRouteRuntimeOptions = {
  warpRouteId: string;
  explorerApiUrl?: string;
  explorerQueryLimit?: number;
  inventoryAddress?: string;
  skipSharedBalanceMetrics?: boolean;
};

/**
 * Builds the MultiProtocolProvider shared by all routes. The Sealevel warp
 * adapters require the Mailbox address, so mailboxes are merged into the
 * chain metadata.
 */
export function buildMultiProtocolProvider(
  chainMetadata: ChainMap<ChainMetadata>,
  chainAddresses: ChainMap<{ mailbox?: string }>,
): MultiProtocolProvider {
  const mailboxes = objMap(chainAddresses, (_, { mailbox }) => ({
    mailbox,
  }));
  return new MultiProtocolProvider(objMerge(chainMetadata, mailboxes));
}

export function buildPriceGetter(
  chainMetadata: ChainMap<ChainMetadata>,
  coingeckoApiKey: string | undefined,
): TokenPriceGetter {
  const tokenPriceGetter = new CoinGeckoTokenPriceGetter({
    chainMetadata,
    apiKey: coingeckoApiKey,
  });

  if (!coingeckoApiKey) {
    getLogger().warn(
      'No CoinGecko API key provided, using public tier (rate limited)',
    );
  }

  return {
    tryGetTokenPrice: async (token: Token) =>
      tryGetTokenPrice(token, tokenPriceGetter),
  };
}

/**
 * Reads chain metadata + addresses from the registry, applies RPC overrides
 * from the environment, and assembles the shared context.
 */
export async function buildSharedContext(
  registry: IRegistry,
  coingeckoApiKey: string | undefined,
): Promise<WarpMonitorSharedContext> {
  const logger = getLogger();
  const chainMetadata = await registry.getMetadata();
  const chainAddresses = await registry.getAddresses();
  const overriddenChains = applyRpcUrlOverridesFromEnv(chainMetadata);
  if (overriddenChains.length > 0) {
    logger.info(
      { chains: overriddenChains, count: overriddenChains.length },
      'Applied RPC overrides from environment variables',
    );
  }

  const multiProtocolProvider = buildMultiProtocolProvider(
    chainMetadata,
    chainAddresses,
  );
  const priceGetter = buildPriceGetter(chainMetadata, coingeckoApiKey);

  return { multiProtocolProvider, chainMetadata, priceGetter };
}

/**
 * Resolves the per-route runtime (warp core, deploy config, router nodes,
 * explorer client) from the registry using a shared context.
 */
export async function buildRouteRuntime(
  registry: IRegistry,
  shared: WarpMonitorSharedContext,
  options: BuildRouteRuntimeOptions,
): Promise<WarpRouteRuntime> {
  const logger = getLogger();
  const {
    warpRouteId,
    explorerApiUrl,
    explorerQueryLimit = 200,
    inventoryAddress,
    skipSharedBalanceMetrics = false,
  } = options;

  const warpCoreConfig = await registry.getWarpRoute(warpRouteId);
  if (!warpCoreConfig) {
    throw new Error(
      `Warp route config for ${warpRouteId} not found in registry`,
    );
  }

  const warpCore = WarpCore.FromConfig(
    shared.multiProtocolProvider,
    warpCoreConfig,
  );
  const warpDeployConfig = await registry.getWarpDeployConfig(warpRouteId);
  const routerNodes = buildRouterNodes(warpCore, shared.chainMetadata);
  const pendingTransfersClient = explorerApiUrl
    ? new ExplorerPendingTransfersClient(explorerApiUrl, routerNodes, logger)
    : undefined;

  logger.info(
    {
      warpRouteId,
      tokenCount: warpCore.tokens.length,
      chains: warpCore.getTokenChains(),
      crossCollateralNodeCount: routerNodes.length,
      explorerEnabled: !!pendingTransfersClient,
      inventoryTrackingEnabled: !!inventoryAddress,
      skipSharedBalanceMetrics,
    },
    'Built warp route runtime',
  );

  return {
    warpRouteId,
    warpCore,
    warpDeployConfig,
    routerNodes,
    pendingTransfersClient,
    explorerQueryLimit,
    inventoryAddress,
    skipSharedBalanceMetrics,
  };
}

/**
 * Resets the per-cycle gauges (pending destination + inventory). These gauges
 * are cleared once per full cycle so that stale label sets (e.g. removed
 * routes or nodes) do not linger. Callers MUST invoke this once before
 * running the routes in a cycle, never per-route (which would wipe series
 * belonging to other routes in the centralized monitor).
 */
export function resetCycleMetrics(): void {
  resetPendingDestinationMetrics();
  resetInventoryBalanceMetrics();
}

/**
 * Emits one full set of metrics for a single route. Does NOT reset gauges —
 * the caller resets once per cycle before running any routes.
 */
export async function runRouteCycle(
  shared: WarpMonitorSharedContext,
  runtime: WarpRouteRuntime,
): Promise<void> {
  const collateralSnapshots = await Promise.all(
    runtime.warpCore.tokens.map(async (token) =>
      updateTokenMetrics(
        runtime.warpCore,
        runtime.warpDeployConfig,
        token,
        shared.priceGetter,
        runtime.warpRouteId,
        runtime.skipSharedBalanceMetrics,
      ),
    ),
  );

  const collateralByNodeId = new Map<string, bigint>();
  for (const snapshot of collateralSnapshots) {
    if (!snapshot) continue;
    collateralByNodeId.set(snapshot.nodeId, snapshot.routerCollateralBaseUnits);
  }

  await updatePendingAndInventoryMetrics(
    runtime.warpCore,
    runtime.routerNodes,
    collateralByNodeId,
    runtime.warpRouteId,
    runtime.pendingTransfersClient,
    runtime.explorerQueryLimit,
    runtime.inventoryAddress,
  );
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

    const shared = await buildSharedContext(this.registry, coingeckoApiKey);
    const runtime = await buildRouteRuntime(this.registry, shared, {
      warpRouteId,
      explorerApiUrl,
      explorerQueryLimit,
      inventoryAddress,
    });

    logger.info(
      {
        warpRouteId,
        checkFrequency,
        tokenCount: runtime.warpCore.tokens.length,
        chains: runtime.warpCore.getTokenChains(),
      },
      'Starting warp route monitor',
    );

    for (;;) {
      await tryFn(
        async () => {
          resetCycleMetrics();
          await runRouteCycle(shared, runtime);
        },
        'Updating warp route metrics',
        logger,
      );
      await sleep(checkFrequency);
    }
  }
}

export async function updatePendingAndInventoryMetrics(
  warpCore: WarpCore,
  routerNodes: RouterNodeMetadata[],
  collateralByNodeId: Map<string, bigint>,
  warpRouteId: string,
  pendingTransfersClient?: ExplorerPendingTransfersClient,
  explorerQueryLimit = 200,
  inventoryAddress?: string,
): Promise<void> {
  const logger = getLogger();
  const now = Date.now();

  const pendingByNodeId = new Map<string, PendingDestinationAggregate>();
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
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        {
          warpRouteId,
          error: message,
        },
        'Failed to query explorer pending transfers',
      );
    }
  }

  const deficits: Array<{ nodeId: string; projectedDeficit: string }> = [];
  for (const node of routerNodes) {
    const aggregate = pendingByNodeId.get(node.nodeId) ?? {
      amountBaseUnits: 0n,
      count: 0,
      oldestPendingSeconds: 0,
    };

    const routerCollateral = collateralByNodeId.get(node.nodeId) ?? 0n;

    updatePendingDestinationMetrics({
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

    const projectedDeficitBaseUnits =
      aggregate.amountBaseUnits > routerCollateral
        ? aggregate.amountBaseUnits - routerCollateral
        : 0n;

    updateProjectedDeficitMetrics({
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

  if (!inventoryAddress) return;

  await Promise.all(
    routerNodes.map(async (node) => {
      try {
        const adapter = node.token.getAdapter(warpCore.multiProvider);
        const inventoryBalance = await adapter.getBalance(inventoryAddress);

        updateInventoryBalanceMetrics({
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
}

// Updates the metrics for a single token in a warp route.
async function updateTokenMetrics(
  warpCore: WarpCore,
  warpDeployConfig: WarpRouteDeployConfig | null,
  token: Token,
  tokenPriceGetter: TokenPriceGetter,
  warpRouteId: string,
  skipSharedBalanceMetrics: boolean,
): Promise<RouterCollateralSnapshot | null> {
  const logger = getLogger();
  let collateralSnapshot: RouterCollateralSnapshot | null = null;
  const promises = [
    tryFn(
      async () => {
        const bridgedSupply = token.isHypToken()
          ? await token.getHypAdapter(warpCore.multiProvider).getBridgedSupply()
          : undefined;

        // The router collateral snapshot is required for the projected-deficit
        // metric even when the shared balance metrics are skipped, so always
        // compute the bridged supply / balance info.
        const balanceInfo = await getTokenBridgedBalance(
          warpCore,
          token,
          tokenPriceGetter,
          logger,
          bridgedSupply,
        );

        if (balanceInfo && !skipSharedBalanceMetrics) {
          updateTokenBalanceMetrics(warpCore, token, balanceInfo, warpRouteId);
        }

        if (bridgedSupply !== undefined) {
          collateralSnapshot = {
            nodeId: buildNodeId(token),
            routerCollateralBaseUnits: bridgedSupply,
            token,
          };
        }
      },
      'Getting bridged balance and value',
      logger,
    ),
  ];

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
              tokenPriceGetter,
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

// Tries to get the price of a token from CoinGecko. Returns undefined if there's no
// CoinGecko ID for the token.
async function tryGetTokenPrice(
  token: Token,
  tokenPriceGetter: CoinGeckoTokenPriceGetter,
): Promise<number | undefined> {
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

  const prices = await tokenPriceGetter.getTokenPriceByIds([coinGeckoId]);
  if (!prices) return undefined;
  return prices[0];
}
