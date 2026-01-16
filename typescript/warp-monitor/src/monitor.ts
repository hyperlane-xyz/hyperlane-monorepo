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
import { ProtocolType, objMap, objMerge, sleep } from '@hyperlane-xyz/utils';
import {
  type TokenPriceGetter,
  getExtraLockboxBalance,
  getExtraLockboxInfo,
  getManagedLockBoxCollateralInfo,
  getSealevelAtaPayerBalance,
  getTokenBridgedBalance,
  getXERC20Info,
  tryFn,
} from '@hyperlane-xyz/warp-metrics';

import {
  metricsRegister,
  startMetricsServer,
  updateManagedLockboxBalanceMetrics,
  updateNativeWalletBalanceMetrics,
  updateTokenBalanceMetrics,
  updateXERC20LimitsMetrics,
} from './metrics.js';
import type { WarpMonitorConfig } from './types.js';
import { getLogger, setLoggerBindings } from './utils.js';

export class WarpMonitor {
  private readonly config: WarpMonitorConfig;
  private readonly registry: IRegistry;

  constructor(config: WarpMonitorConfig, registry: IRegistry) {
    this.config = config;
    this.registry = registry;
  }

  async start(): Promise<void> {
    const logger = getLogger();
    const { warpRouteId, checkFrequency, coingeckoApiKey } = this.config;

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

    logger.info(
      {
        warpRouteId,
        checkFrequency,
        tokenCount: warpCore.tokens.length,
        chains: warpCore.getTokenChains(),
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
    );
  }

  // Indefinitely loops, updating warp route metrics at the specified frequency.
  private async pollAndUpdateWarpRouteMetrics(
    checkFrequency: number,
    warpCore: WarpCore,
    warpDeployConfig: WarpRouteDeployConfig | null,
    chainMetadata: ChainMap<ChainMetadata>,
    warpRouteId: string,
    coingeckoApiKey?: string,
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
          await Promise.all(
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
        },
        'Updating warp route metrics',
        logger,
      );
      await sleep(checkFrequency);
    }
  }

  // Updates the metrics for a single token in a warp route.
  private async updateTokenMetrics(
    warpCore: WarpCore,
    warpDeployConfig: WarpRouteDeployConfig | null,
    token: Token,
    tokenPriceGetter: TokenPriceGetter,
    warpRouteId: string,
  ): Promise<void> {
    const logger = getLogger();
    const promises = [
      tryFn(
        async () => {
          const balanceInfo = await getTokenBridgedBalance(
            warpCore,
            token,
            tokenPriceGetter,
            logger,
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
        return;
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
        return;
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
