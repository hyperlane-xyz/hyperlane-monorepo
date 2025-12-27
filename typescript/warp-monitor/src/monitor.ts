import { Contract, type PopulatedTransaction } from 'ethers';

import { IXERC20VS__factory } from '@hyperlane-xyz/core';
import type { IRegistry } from '@hyperlane-xyz/registry';
import {
  type ChainMap,
  type ChainMetadata,
  CoinGeckoTokenPriceGetter,
  EvmHypXERC20Adapter,
  EvmHypXERC20LockboxAdapter,
  EvmTokenAdapter,
  type IHypXERC20Adapter,
  MultiProtocolProvider,
  SealevelHypTokenAdapter,
  Token,
  TokenStandard,
  TokenType,
  WarpCore,
  type WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import {
  type Address,
  ProtocolType,
  objMap,
  objMerge,
  sleep,
} from '@hyperlane-xyz/utils';

import {
  metricsRegister,
  startMetricsServer,
  updateManagedLockboxBalanceMetrics,
  updateNativeWalletBalanceMetrics,
  updateTokenBalanceMetrics,
  updateXERC20LimitsMetrics,
} from './metrics.js';
import type {
  NativeWalletBalance,
  WarpMonitorConfig,
  WarpRouteBalance,
  XERC20Limit,
} from './types.js';
import { getLogger, setLoggerBindings, tryFn } from './utils.js';

interface XERC20Info {
  limits: XERC20Limit;
  xERC20Address: Address;
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

    while (true) {
      await tryFn(async () => {
        await Promise.all(
          warpCore.tokens.map((token) =>
            this.updateTokenMetrics(
              warpCore,
              warpDeployConfig,
              token,
              tokenPriceGetter,
              warpRouteId,
            ),
          ),
        );
      }, 'Updating warp route metrics');
      await sleep(checkFrequency);
    }
  }

  // Updates the metrics for a single token in a warp route.
  private async updateTokenMetrics(
    warpCore: WarpCore,
    warpDeployConfig: WarpRouteDeployConfig | null,
    token: Token,
    tokenPriceGetter: CoinGeckoTokenPriceGetter,
    warpRouteId: string,
  ): Promise<void> {
    const logger = getLogger();
    const promises = [
      tryFn(async () => {
        const balanceInfo = await this.getTokenBridgedBalance(
          warpCore,
          token,
          tokenPriceGetter,
        );
        if (!balanceInfo) {
          return;
        }
        updateTokenBalanceMetrics(warpCore, token, balanceInfo, warpRouteId);
      }, 'Getting bridged balance and value'),
    ];

    // For Sealevel collateral and synthetic tokens, there is an
    // "Associated Token Account" (ATA) rent payer that has a balance
    // that's used to pay for rent for the accounts that store user balances.
    // This is necessary if the recipient has never received any tokens before.
    if (token.protocol === ProtocolType.Sealevel && !token.isNative()) {
      promises.push(
        tryFn(async () => {
          const balance = await this.getSealevelAtaPayerBalance(
            warpCore,
            token,
            warpRouteId,
          );
          updateNativeWalletBalanceMetrics(balance);
        }, 'Getting ATA payer balance'),
      );
    }

    if (token.isXerc20()) {
      promises.push(
        tryFn(async () => {
          const { limits, xERC20Address } = await this.getXERC20Info(
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
        }, 'Getting xERC20 limits'),
      );

      if (!warpDeployConfig) {
        logger.warn(
          { token: token.symbol, chain: token.chainName },
          'Failed to read warp deploy config, skipping extra lockboxes',
        );
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
        return;
      }

      const extraLockboxes =
        currentTokenDeployConfig.xERC20?.extraBridges ?? [];

      for (const lockbox of extraLockboxes) {
        promises.push(
          tryFn(async () => {
            const { limits, xERC20Address } = await this.getExtraLockboxInfo(
              token,
              warpCore.multiProvider,
              lockbox.lockbox,
            );

            updateXERC20LimitsMetrics(
              token,
              limits,
              lockbox.lockbox,
              'EvmManagedLockbox',
              xERC20Address,
            );
          }, 'Getting extra lockbox limits'),
          tryFn(async () => {
            const balance = await this.getExtraLockboxBalance(
              token,
              warpCore.multiProvider,
              tokenPriceGetter,
              lockbox.lockbox,
            );

            if (balance) {
              const { tokenName, tokenAddress } =
                await this.getManagedLockBoxCollateralInfo(
                  token,
                  warpCore.multiProvider,
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
          }, `Updating extra lockbox balance for contract at "${lockbox.lockbox}" on chain ${token.chainName}`),
        );
      }
    }

    await Promise.all(promises);
  }

  // Gets the bridged balance and value of a token in a warp route.
  private async getTokenBridgedBalance(
    warpCore: WarpCore,
    token: Token,
    tokenPriceGetter: CoinGeckoTokenPriceGetter,
  ): Promise<WarpRouteBalance | undefined> {
    const logger = getLogger();
    if (!token.isHypToken()) {
      logger.warn(
        { token: token.symbol, chain: token.chainName },
        'No support for bridged balance on non-Hyperlane token',
      );
      return undefined;
    }

    const adapter = token.getHypAdapter(warpCore.multiProvider);
    let tokenAddress = token.collateralAddressOrDenom ?? token.addressOrDenom;
    const bridgedSupply = await adapter.getBridgedSupply();
    if (bridgedSupply === undefined) {
      logger.warn(
        { token: token.symbol, chain: token.chainName },
        'Failed to get bridged supply',
      );
      return undefined;
    }
    const balance = token.amount(bridgedSupply).getDecimalFormattedAmount();

    let tokenPrice;
    // Only record value for collateralized and xERC20 lockbox tokens.
    if (
      token.isCollateralized() ||
      token.standard === TokenStandard.EvmHypXERC20Lockbox ||
      token.standard === TokenStandard.EvmHypVSXERC20Lockbox
    ) {
      tokenPrice = await this.tryGetTokenPrice(token, tokenPriceGetter);
    }

    if (
      token.standard === TokenStandard.EvmHypXERC20Lockbox ||
      token.standard === TokenStandard.EvmHypVSXERC20Lockbox
    ) {
      tokenAddress = (await (adapter as EvmHypXERC20LockboxAdapter).getXERC20())
        .address;
    }

    return {
      balance,
      valueUSD: tokenPrice ? balance * tokenPrice : undefined,
      tokenAddress,
    };
  }

  private async getManagedLockBoxCollateralInfo(
    warpToken: Token,
    multiProtocolProvider: MultiProtocolProvider,
    lockBoxAddress: Address,
  ): Promise<{ tokenName: string; tokenAddress: Address }> {
    const lockBoxInstance = await this.getManagedLockBox(
      warpToken,
      multiProtocolProvider,
      lockBoxAddress,
    );

    const collateralTokenAddress = await lockBoxInstance.ERC20();
    const collateralTokenAdapter = new EvmTokenAdapter(
      warpToken.chainName,
      multiProtocolProvider,
      {
        token: collateralTokenAddress,
      },
    );

    const { name } = await collateralTokenAdapter.getMetadata();

    return {
      tokenName: name,
      tokenAddress: collateralTokenAddress,
    };
  }

  private formatBigInt(warpToken: Token, num: bigint): number {
    return warpToken.amount(num).getDecimalFormattedAmount();
  }

  // Gets the native balance of the ATA payer, which is used to pay for
  // rent when delivering tokens to an account that previously didn't
  // have a balance.
  // Only intended for Collateral or Synthetic Sealevel tokens.
  private async getSealevelAtaPayerBalance(
    warpCore: WarpCore,
    token: Token,
    warpRouteId: string,
  ): Promise<NativeWalletBalance> {
    if (token.protocol !== ProtocolType.Sealevel || token.isNative()) {
      throw new Error(
        `Unsupported ATA payer protocol type ${token.protocol} or standard ${token.standard}`,
      );
    }
    const adapter = token.getHypAdapter(
      warpCore.multiProvider,
    ) as SealevelHypTokenAdapter;

    const ataPayer = adapter.deriveAtaPayerAccount().toString();
    const nativeToken = Token.FromChainMetadataNativeToken(
      warpCore.multiProvider.getChainMetadata(token.chainName),
    );
    const ataPayerBalance = await nativeToken.getBalance(
      warpCore.multiProvider,
      ataPayer,
    );
    return {
      chain: token.chainName,
      walletAddress: ataPayer.toString(),
      walletName: `${warpRouteId}/ata-payer`,
      balance: ataPayerBalance.getDecimalFormattedAmount(),
    };
  }

  private async getXERC20Info(
    warpCore: WarpCore,
    token: Token,
  ): Promise<XERC20Info> {
    if (token.protocol !== ProtocolType.Ethereum) {
      throw new Error(`Unsupported XERC20 protocol type ${token.protocol}`);
    }

    if (
      token.standard === TokenStandard.EvmHypXERC20 ||
      token.standard === TokenStandard.EvmHypVSXERC20
    ) {
      const adapter = token.getAdapter(
        warpCore.multiProvider,
      ) as EvmHypXERC20Adapter;
      return {
        limits: await this.getXERC20Limit(token, adapter),
        xERC20Address: (await adapter.getXERC20()).address,
      };
    } else if (
      token.standard === TokenStandard.EvmHypXERC20Lockbox ||
      token.standard === TokenStandard.EvmHypVSXERC20Lockbox
    ) {
      const adapter = token.getAdapter(
        warpCore.multiProvider,
      ) as EvmHypXERC20LockboxAdapter;
      return {
        limits: await this.getXERC20Limit(token, adapter),
        xERC20Address: (await adapter.getXERC20()).address,
      };
    }
    throw new Error(`Unsupported XERC20 token standard ${token.standard}`);
  }

  private async getXERC20Limit(
    token: Token,
    xerc20: IHypXERC20Adapter<PopulatedTransaction>,
  ): Promise<XERC20Limit> {
    const [mintCurrent, mintMax, burnCurrent, burnMax] = await Promise.all([
      xerc20.getMintLimit(),
      xerc20.getMintMaxLimit(),
      xerc20.getBurnLimit(),
      xerc20.getBurnMaxLimit(),
    ]);

    return {
      mint: this.formatBigInt(token, mintCurrent),
      mintMax: this.formatBigInt(token, mintMax),
      burn: this.formatBigInt(token, burnCurrent),
      burnMax: this.formatBigInt(token, burnMax),
    };
  }

  private readonly managedLockBoxMinimalABI = [
    'function XERC20() view returns (address)',
    'function ERC20() view returns (address)',
  ] as const;

  private async getExtraLockboxInfo(
    warpToken: Token,
    multiProtocolProvider: MultiProtocolProvider,
    lockboxAddress: Address,
  ): Promise<XERC20Info> {
    const currentChainProvider = multiProtocolProvider.getEthersV5Provider(
      warpToken.chainName,
    );
    const lockboxInstance = await this.getManagedLockBox(
      warpToken,
      multiProtocolProvider,
      lockboxAddress,
    );

    const xERC20Address = await lockboxInstance.XERC20();
    const vsXERC20Address = IXERC20VS__factory.connect(
      xERC20Address,
      currentChainProvider,
    ); // todo use adapter

    const [mintMax, burnMax, mint, burn] = await Promise.all([
      vsXERC20Address.mintingMaxLimitOf(lockboxAddress),
      vsXERC20Address.burningMaxLimitOf(lockboxAddress),
      vsXERC20Address.mintingCurrentLimitOf(lockboxAddress),
      vsXERC20Address.burningCurrentLimitOf(lockboxAddress),
    ]);

    return {
      limits: {
        burn: this.formatBigInt(warpToken, burn.toBigInt()),
        burnMax: this.formatBigInt(warpToken, burnMax.toBigInt()),
        mint: this.formatBigInt(warpToken, mint.toBigInt()),
        mintMax: this.formatBigInt(warpToken, mintMax.toBigInt()),
      },
      xERC20Address,
    };
  }

  private async getManagedLockBox(
    warpToken: Token,
    multiProtocolProvider: MultiProtocolProvider,
    lockboxAddress: Address,
  ): Promise<Contract> {
    const chainName = warpToken.chainName;
    const provider = multiProtocolProvider.getEthersV5Provider(chainName);
    return new Contract(
      lockboxAddress,
      this.managedLockBoxMinimalABI,
      provider,
    );
  }

  private async getExtraLockboxBalance(
    warpToken: Token,
    multiProtocolProvider: MultiProtocolProvider,
    tokenPriceGetter: CoinGeckoTokenPriceGetter,
    lockboxAddress: Address,
  ): Promise<WarpRouteBalance | undefined> {
    const logger = getLogger();
    if (!warpToken.isXerc20()) {
      return;
    }

    const lockboxInstance = await this.getManagedLockBox(
      warpToken,
      multiProtocolProvider,
      lockboxAddress,
    );

    const erc20TokenAddress = await lockboxInstance.ERC20();
    const erc20tokenAdapter = new EvmTokenAdapter(
      warpToken.chainName,
      multiProtocolProvider,
      {
        token: erc20TokenAddress,
      },
    );

    let balance;
    try {
      balance = await erc20tokenAdapter.getBalance(lockboxAddress);
    } catch (err) {
      logger.error(
        {
          err,
          chain: warpToken.chainName,
          token: warpToken.symbol,
          lockboxAddress,
          erc20TokenAddress,
        },
        'Failed to get balance for contract at lockbox address',
      );
      return;
    }

    const tokenPrice = await this.tryGetTokenPrice(warpToken, tokenPriceGetter);

    const balanceNumber = this.formatBigInt(warpToken, balance);

    return {
      balance: balanceNumber,
      valueUSD: tokenPrice ? balanceNumber * tokenPrice : undefined,
      tokenAddress: erc20TokenAddress,
    };
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
