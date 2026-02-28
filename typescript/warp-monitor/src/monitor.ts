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
      { port: process.env['PROMETHEUS_PORT'] || '9090' },
      'Metrics server started',
    );

    // Get chain metadata and addresses from registry
    const chainMetadata = await this.registry.getMetadata();
    const chainAddresses = await this.registry.getAddresses();
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

    // Get warp route config from registry
    const warpCoreConfig = await this.registry.getWarpRoute(warpRouteId);
    if (!warpCoreConfig) {
      throw new Error(
        `Warp route config for ${warpRouteId} not found in registry`,
      );
    }

    const warpCore = WarpCore.FromConfig(multiProtocolProvider, warpCoreConfig);
    const warpDeployConfig =
      await this.registry.getWarpDeployConfig(warpRouteId);
    const routerNodes = this.buildRouterNodes(warpCore, chainMetadata);
    const pendingTransfersClient = explorerApiUrl
      ? new ExplorerPendingTransfersClient(explorerApiUrl, routerNodes, logger)
      : undefined;

    logger.info(
      {
        warpRouteId,
        checkFrequency,
        tokenCount: warpCore.tokens.length,
        chains: warpCore.getTokenChains(),
        multiCollateralNodeCount: routerNodes.length,
        explorerEnabled: !!pendingTransfersClient,
        inventoryTrackingEnabled: !!inventoryAddress,
      },
      'Starting warp route monitor',
    );

    await this.pollAndUpdateWarpRouteMetrics(
      checkFrequency,
      warpCore,
      warpDeployConfig,
      chainMetadata,
      warpRouteId,
      coingeckoApiKey,
      routerNodes,
      pendingTransfersClient,
      explorerQueryLimit,
      inventoryAddress,
    );
  }

  // Indefinitely loops, updating warp route metrics at the specified frequency.
  private async pollAndUpdateWarpRouteMetrics(
    checkFrequency: number,
    warpCore: WarpCore,
    warpDeployConfig: WarpRouteDeployConfig | null,
    chainMetadata: ChainMap<ChainMetadata>,
    warpRouteId: string,
    coingeckoApiKey: string | undefined,
    routerNodes: RouterNodeMetadata[],
    pendingTransfersClient?: ExplorerPendingTransfersClient,
    explorerQueryLimit = 200,
    inventoryAddress?: string,
  ): Promise<void> {
    const logger = getLogger();
    const tokenPriceGetter = new CoinGeckoTokenPriceGetter({
      chainMetadata,
      apiKey: coingeckoApiKey,
    });

    if (!coingeckoApiKey) {
      logger.warn(
        'No CoinGecko API key provided, using public tier (rate limited)',
      );
    }

    // Wrap CoinGeckoTokenPriceGetter to match TokenPriceGetter interface
    const priceGetter: TokenPriceGetter = {
      tryGetTokenPrice: async (token: Token) => {
        return this.tryGetTokenPrice(token, tokenPriceGetter);
      },
    };

    while (true) {
      await tryFn(
        async () => {
          const collateralSnapshots = await Promise.all(
            warpCore.tokens.map((token) =>
              this.updateTokenMetrics(
                warpCore,
                warpDeployConfig,
                token,
                priceGetter,
                warpRouteId,
              ),
            ),
          );

          const collateralByNodeId = new Map<string, bigint>();
          for (const snapshot of collateralSnapshots) {
            if (!snapshot) continue;
            collateralByNodeId.set(
              snapshot.nodeId,
              snapshot.routerCollateralBaseUnits,
            );
          }

          await this.updatePendingAndInventoryMetrics(
            warpCore,
            routerNodes,
            collateralByNodeId,
            warpRouteId,
            pendingTransfersClient,
            explorerQueryLimit,
            inventoryAddress,
          );
        },
        'Updating warp route metrics',
        logger,
      );
      await sleep(checkFrequency);
    }
  }

  private async updatePendingAndInventoryMetrics(
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

    resetPendingDestinationMetrics();
    resetInventoryBalanceMetrics();

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
      } catch (error) {
        logger.error(
          {
            error: (error as Error).message,
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
      const projectedDeficitBaseUnits =
        aggregate.amountBaseUnits > routerCollateral
          ? aggregate.amountBaseUnits - routerCollateral
          : 0n;

      updatePendingDestinationMetrics({
        warpRouteId,
        nodeId: node.nodeId,
        chainName: node.chainName,
        routerAddress: node.routerAddress,
        tokenAddress: node.tokenAddress,
        tokenSymbol: node.tokenSymbol,
        tokenName: node.tokenName,
        pendingAmount: this.formatTokenAmount(node.token, aggregate.amountBaseUnits),
        pendingCount: aggregate.count,
        oldestPendingSeconds: aggregate.oldestPendingSeconds,
        projectedDeficit: this.formatTokenAmount(
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
          deficits,
          deficitNodeCount: deficits.length,
        },
        'Detected projected destination deficits from pending transfers',
      );
    }

    if (!inventoryAddress) return;

    await Promise.all(
      routerNodes.map(async (node) => {
        let inventoryBalance = 0n;

        await tryFn(
          async () => {
            const adapter = node.token.getAdapter(warpCore.multiProvider);
            inventoryBalance = await adapter.getBalance(inventoryAddress);
          },
          `Reading inventory balance for ${node.nodeId}`,
          logger,
        );

        updateInventoryBalanceMetrics({
          warpRouteId,
          nodeId: node.nodeId,
          chainName: node.chainName,
          routerAddress: node.routerAddress,
          tokenAddress: node.tokenAddress,
          tokenSymbol: node.tokenSymbol,
          tokenName: node.tokenName,
          inventoryAddress,
          inventoryBalance: this.formatTokenAmount(node.token, inventoryBalance),
        });
      }),
    );
  }

  // Updates the metrics for a single token in a warp route.
  private async updateTokenMetrics(
    warpCore: WarpCore,
    warpDeployConfig: WarpRouteDeployConfig | null,
    token: Token,
    tokenPriceGetter: TokenPriceGetter,
    warpRouteId: string,
  ): Promise<RouterCollateralSnapshot | null> {
    const logger = getLogger();
    let collateralSnapshot: RouterCollateralSnapshot | null = null;
    const promises = [
      tryFn(
        async () => {
          const bridgedSupply = token.isHypToken()
            ? await token.getHypAdapter(warpCore.multiProvider).getBridgedSupply()
            : undefined;

          const balanceInfo = await getTokenBridgedBalance(
            warpCore,
            token,
            tokenPriceGetter,
            logger,
            bridgedSupply,
          );
          if (!balanceInfo) {
            return;
          }
          updateTokenBalanceMetrics(warpCore, token, balanceInfo, warpRouteId);

          if (bridgedSupply !== undefined) {
            collateralSnapshot = {
              nodeId: this.buildNodeId(token),
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

      const extraLockboxes =
        currentTokenDeployConfig.xERC20?.extraBridges ?? [];

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

  private buildRouterNodes(
    warpCore: WarpCore,
    chainMetadata: ChainMap<ChainMetadata>,
  ): RouterNodeMetadata[] {
    const nodeByKey = new Map<string, RouterNodeMetadata>();

    for (const token of warpCore.tokens) {
      const metadata = chainMetadata[token.chainName];
      if (!metadata) continue;
      if (!ethersUtils.isAddress(token.addressOrDenom)) continue;

      const domainId = metadata.domainId;
      const routerAddress = ethersUtils
        .getAddress(token.addressOrDenom)
        .toLowerCase();
      const key = `${domainId}:${routerAddress}`;
      if (nodeByKey.has(key)) continue;

      nodeByKey.set(key, {
        nodeId: this.buildNodeId(token),
        chainName: token.chainName,
        domainId,
        routerAddress,
        tokenAddress: (token.collateralAddressOrDenom ?? token.addressOrDenom).toLowerCase(),
        tokenName: token.name,
        tokenSymbol: token.symbol,
        tokenDecimals: token.decimals,
        token,
      });
    }

    return [...nodeByKey.values()];
  }

  private buildNodeId(token: Token): string {
    return `${token.symbol}|${token.chainName}|${token.addressOrDenom.toLowerCase()}`;
  }

  private formatTokenAmount(token: Token, amount: bigint): number {
    return token.amount(amount).getDecimalFormattedAmount();
  }

  // Tries to get the price of a token from CoinGecko. Returns undefined if there's no
  // CoinGecko ID for the token.
  private async tryGetTokenPrice(
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

    return this.getCoingeckoPrice(tokenPriceGetter, coinGeckoId);
  }

  private async getCoingeckoPrice(
    tokenPriceGetter: CoinGeckoTokenPriceGetter,
    coingeckoId: string,
  ): Promise<number | undefined> {
    const prices = await tokenPriceGetter.getTokenPriceByIds([coingeckoId]);
    if (!prices) return undefined;
    return prices[0];
  }
}
