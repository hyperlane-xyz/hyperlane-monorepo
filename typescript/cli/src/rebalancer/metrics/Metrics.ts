import { Contract, PopulatedTransaction } from 'ethers';

import { IXERC20VS__factory } from '@hyperlane-xyz/core';
import { IRegistry, createWarpRouteConfigId } from '@hyperlane-xyz/registry';
import {
  ChainMap,
  ChainMetadata,
  CoinGeckoTokenPriceGetter,
  EvmHypXERC20Adapter,
  EvmHypXERC20LockboxAdapter,
  EvmTokenAdapter,
  IHypXERC20Adapter,
  MultiProtocolProvider,
  SealevelHypTokenAdapter,
  Token,
  TokenStandard,
  TokenType,
  WarpCore,
  WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { Address, ProtocolType, objMap, objMerge } from '@hyperlane-xyz/utils';

import { MonitorEvent } from '../interfaces/IMonitor.js';

import {
  updateManagedLockboxBalanceMetrics,
  updateNativeWalletBalanceMetrics,
  updateTokenBalanceMetrics,
  updateXERC20LimitsMetrics,
} from './helpers.js';
import { NativeWalletBalance, WarpRouteBalance, XERC20Limit } from './types.js';
import { logger, tryFn } from './utils.js';

interface XERC20Info {
  limits: XERC20Limit;
  xERC20Address: Address;
}

export interface IMetrics {
  processEvent(event: MonitorEvent): Promise<void>;
}

export class Metrics implements IMetrics {
  private readonly managedLockBoxMinimalABI = [
    'function XERC20() view returns (address)',
    'function ERC20() view returns (address)',
  ] as const;

  private constructor(
    private readonly registry: IRegistry,
    private readonly warpRouteId: string,
    private readonly tokenPriceGetter: PriceGetter,
    private readonly collateralTokenSymbol: string,
    private readonly warpCore: WarpCore,
    private readonly warpDeployConfig: WarpRouteDeployConfig | null,
  ) {}

  public static async create(registry: IRegistry, warpRouteId: string) {
    const metadata = await registry.getMetadata();
    const addresses = await registry.getAddresses();

    // The Sealevel warp adapters require the Mailbox address, so we
    // get mailboxes for all chains and merge them with the chain metadata.
    const mailboxes = objMap(addresses, (_, { mailbox }) => ({ mailbox }));
    const provider = new MultiProtocolProvider(objMerge(metadata, mailboxes));
    const warpCoreConfig = await registry.getWarpRoute(warpRouteId);
    const warpCore = WarpCore.FromConfig(provider, warpCoreConfig);
    const warpDeployConfig = await registry.getWarpDeployConfig(warpRouteId);
    const collateralTokenSymbol =
      Metrics.getWarpRouteCollateralTokenSymbol(warpCore);
    const tokenPriceGetter = await PriceGetter.create(metadata);

    return new Metrics(
      registry,
      warpRouteId,
      tokenPriceGetter,
      collateralTokenSymbol,
      warpCore,
      warpDeployConfig,
    );
  }

  async processEvent({ token }: MonitorEvent) {
    await tryFn(async () => {
      if (!token) {
        return;
      }

      await this.updateTokenMetrics(token);
    }, 'Updating warp route metrics');
  }

  // Updates the metrics for a single token in a warp route.
  private async updateTokenMetrics(token: Token): Promise<void> {
    const promises = [
      tryFn(async () => {
        const balanceInfo = await this.getTokenBridgedBalance(token);

        if (!balanceInfo) {
          return;
        }

        updateTokenBalanceMetrics(
          this.warpCore,
          token,
          balanceInfo,
          this.collateralTokenSymbol,
        );
      }, 'Getting bridged balance and value'),
    ];

    // For Sealevel collateral and synthetic tokens, there is an
    // "Associated Token Account" (ATA) rent payer that has a balance
    // that's used to pay for rent for the accounts that store user balances.
    // This is necessary if the recipient has never received any tokens before.
    if (token.protocol === ProtocolType.Sealevel && !token.isNative()) {
      promises.push(
        tryFn(async () => {
          const balance = await this.getSealevelAtaPayerBalance(token);

          updateNativeWalletBalanceMetrics(balance);
        }, 'Getting ATA payer balance'),
      );
    }

    if (token.isXerc20()) {
      promises.push(
        tryFn(async () => {
          const { limits, xERC20Address } = await this.getXERC20Info(token);
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

      if (!this.warpDeployConfig) {
        logger.warn(
          `Can't read warp deploy config for token ${token.symbol} on chain ${token.chainName} skipping extra lockboxes`,
        );
        return;
      }

      // If the current token is an xERC20, we need to check if there are any extra lockboxes
      const currentTokenDeployConfig = this.warpDeployConfig[token.chainName];

      if (
        currentTokenDeployConfig.type !== TokenType.XERC20 &&
        currentTokenDeployConfig.type !== TokenType.XERC20Lockbox
      ) {
        logger.error('Token is xERC20 but token deploy config is not');
        return;
      }

      const extraLockboxes =
        currentTokenDeployConfig.xERC20?.extraBridges ?? [];

      for (const lockbox of extraLockboxes) {
        promises.push(
          tryFn(async () => {
            const { limits, xERC20Address } = await this.getExtraLockboxInfo(
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
          }, 'Getting extra lockbox limits'),
          tryFn(async () => {
            const balance = await this.getExtraLockboxBalance(
              token,
              lockbox.lockbox,
            );

            if (balance) {
              const { tokenName, tokenAddress } =
                await this.getManagedLockBoxCollateralInfo(
                  token,
                  lockbox.lockbox,
                );

              updateManagedLockboxBalanceMetrics(
                this.warpCore,
                token.chainName,
                tokenName,
                tokenAddress,
                lockbox.lockbox,
                balance,
                this.collateralTokenSymbol,
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
    token: Token,
  ): Promise<WarpRouteBalance | undefined> {
    if (!token.isHypToken()) {
      logger.warn(
        'Cannot get bridged balance for a non-Hyperlane token',
        token,
      );
      return undefined;
    }

    const adapter = token.getHypAdapter(this.warpCore.multiProvider);
    let tokenAddress = token.collateralAddressOrDenom ?? token.addressOrDenom;
    const bridgedSupply = await adapter.getBridgedSupply();

    if (bridgedSupply === undefined) {
      logger.warn('Bridged supply not found for token', token);
      return undefined;
    }

    const balance = token.amount(bridgedSupply).getDecimalFormattedAmount();

    let tokenPrice;
    // Only record value for collateralized and xERC20 lockbox tokens.
    // removed the check for `EvmHypXERC20Lockbox` as it's already listed as collateralized
    if (token.isCollateralized()) {
      tokenPrice = await this.tokenPriceGetter.tryGetTokenPrice(token);
    }

    if (token.standard === TokenStandard.EvmHypXERC20Lockbox) {
      tokenAddress = (await (adapter as EvmHypXERC20LockboxAdapter).getXERC20())
        .address;
    }

    return {
      balance,
      valueUSD: tokenPrice ? balance * tokenPrice : undefined,
      tokenAddress,
    };
  }

  // Gets the native balance of the ATA payer, which is used to pay for
  // rent when delivering tokens to an account that previously didn't
  // have a balance.
  // Only intended for Collateral or Synthetic Sealevel tokens.
  private async getSealevelAtaPayerBalance(
    token: Token,
  ): Promise<NativeWalletBalance> {
    if (token.protocol !== ProtocolType.Sealevel || token.isNative()) {
      throw new Error(
        `Unsupported ATA payer protocol type ${token.protocol} or standard ${token.standard}`,
      );
    }
    const adapter = token.getHypAdapter(
      this.warpCore.multiProvider,
    ) as SealevelHypTokenAdapter;

    const ataPayer = adapter.deriveAtaPayerAccount().toString();
    const nativeToken = Token.FromChainMetadataNativeToken(
      this.warpCore.multiProvider.getChainMetadata(token.chainName),
    );
    const ataPayerBalance = await nativeToken.getBalance(
      this.warpCore.multiProvider,
      ataPayer,
    );

    const warpRouteId = createWarpRouteConfigId(
      token.symbol,
      this.warpCore.getTokenChains(),
    );

    return {
      chain: token.chainName,
      walletAddress: ataPayer.toString(),
      walletName: `${warpRouteId}/ata-payer`,
      balance: ataPayerBalance.getDecimalFormattedAmount(),
    };
  }

  private async getXERC20Info(token: Token): Promise<XERC20Info> {
    if (token.protocol !== ProtocolType.Ethereum) {
      throw new Error(`Unsupported XERC20 protocol type ${token.protocol}`);
    }

    if (token.standard === TokenStandard.EvmHypXERC20) {
      const adapter = token.getAdapter(
        this.warpCore.multiProvider,
      ) as EvmHypXERC20Adapter;
      return {
        limits: await this.getXERC20Limit(token, adapter),
        xERC20Address: (await adapter.getXERC20()).address,
      };
    } else if (token.standard === TokenStandard.EvmHypXERC20Lockbox) {
      const adapter = token.getAdapter(
        this.warpCore.multiProvider,
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
      mint: formatBigInt(token, mintCurrent),
      mintMax: formatBigInt(token, mintMax),
      burn: formatBigInt(token, burnCurrent),
      burnMax: formatBigInt(token, burnMax),
    };
  }

  private async getExtraLockboxInfo(
    warpToken: Token,
    lockboxAddress: Address,
  ): Promise<XERC20Info> {
    const currentChainProvider =
      this.warpCore.multiProvider.getEthersV5Provider(warpToken.chainName);
    const lockboxInstance = await this.getManagedLockBox(
      warpToken,
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
        burn: formatBigInt(warpToken, burn.toBigInt()),
        burnMax: formatBigInt(warpToken, burnMax.toBigInt()),
        mint: formatBigInt(warpToken, mint.toBigInt()),
        mintMax: formatBigInt(warpToken, mintMax.toBigInt()),
      },
      xERC20Address,
    };
  }

  private async getManagedLockBox(
    warpToken: Token,
    lockboxAddress: Address,
  ): Promise<Contract> {
    const chainName = warpToken.chainName;
    const provider = this.warpCore.multiProvider.getEthersV5Provider(chainName);

    return new Contract(
      lockboxAddress,
      this.managedLockBoxMinimalABI,
      provider,
    );
  }

  private async getExtraLockboxBalance(
    warpToken: Token,
    lockboxAddress: Address,
  ): Promise<WarpRouteBalance | undefined> {
    if (!warpToken.isXerc20()) {
      return;
    }

    const lockboxInstance = await this.getManagedLockBox(
      warpToken,
      lockboxAddress,
    );

    const erc20TokenAddress = await lockboxInstance.ERC20();
    const erc20tokenAdapter = new EvmTokenAdapter(
      warpToken.chainName,
      this.warpCore.multiProvider,
      {
        token: erc20TokenAddress,
      },
    );

    let balance;
    try {
      balance = await erc20tokenAdapter.getBalance(lockboxAddress);
    } catch (e) {
      logger.error(
        `Error getting balance for contract at "${lockboxAddress}" on chain ${warpToken.chainName} on token ${erc20TokenAddress}`,
        e,
      );
      return;
    }

    const tokenPrice = await this.tokenPriceGetter.tryGetTokenPrice(warpToken);

    const balanceNumber = formatBigInt(warpToken, balance);

    return {
      balance: balanceNumber,
      valueUSD: tokenPrice ? balanceNumber * tokenPrice : undefined,
      tokenAddress: erc20TokenAddress,
    };
  }

  private async getManagedLockBoxCollateralInfo(
    warpToken: Token,
    lockBoxAddress: Address,
  ): Promise<{ tokenName: string; tokenAddress: Address }> {
    const lockBoxInstance = await this.getManagedLockBox(
      warpToken,
      lockBoxAddress,
    );

    const collateralTokenAddress = await lockBoxInstance.ERC20();
    const collateralTokenAdapter = new EvmTokenAdapter(
      warpToken.chainName,
      this.warpCore.multiProvider,
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

  private static getWarpRouteCollateralTokenSymbol(warpCore: WarpCore): string {
    // We need to have a deterministic way to determine the symbol of the warp route
    // as its used to identify the warp route in metrics. This method should support routes where:
    // - All tokens have the same symbol, token standards can be all collateral, all synthetic or a mix
    // - All tokens have different symbol, but there is a collateral token to break the tie, where there are multiple collateral tokens, alphabetically first is chosen
    // - All tokens have different symbol, but there is no collateral token to break the tie, pick the alphabetically first symbol

    // Get all unique symbols from the tokens array
    const uniqueSymbols = new Set(warpCore.tokens.map((token) => token.symbol));

    // If all tokens have the same symbol, return that symbol
    if (uniqueSymbols.size === 1) {
      return warpCore.tokens[0].symbol;
    }

    // Find all collateralized tokens
    const collateralTokens = warpCore.tokens.filter(
      (token) =>
        token.isCollateralized() ||
        token.standard === TokenStandard.EvmHypXERC20Lockbox,
    );

    if (collateralTokens.length === 0) {
      // If there are no collateralized tokens, return the alphabetically first symbol
      return [...uniqueSymbols].sort()[0];
    }

    // if there is a single unique collateral symbol return it or
    // if there are multiple, return the alphabetically first symbol
    const collateralSymbols = collateralTokens.map((token) => token.symbol);
    const uniqueCollateralSymbols = [...new Set(collateralSymbols)];

    return uniqueCollateralSymbols.sort()[0];
  }
}

class PriceGetter extends CoinGeckoTokenPriceGetter {
  private constructor({
    chainMetadata,
    apiKey,
    expirySeconds,
    sleepMsBetweenRequests,
  }: {
    chainMetadata: ChainMap<ChainMetadata>;
    apiKey?: string;
    expirySeconds?: number;
    sleepMsBetweenRequests?: number;
  }) {
    super({ chainMetadata, apiKey, expirySeconds, sleepMsBetweenRequests });
  }

  public static async create(chainMetadata: ChainMap<ChainMetadata>) {
    const apiKey = await PriceGetter.getCoinGeckoApiKey();

    return new PriceGetter({ chainMetadata, apiKey });
  }

  // Tries to get the price of a token from CoinGecko. Returns undefined if there's no
  // CoinGecko ID for the token.
  async tryGetTokenPrice(token: Token): Promise<number | undefined> {
    // We only get a price if the token defines a CoinGecko ID.
    // This way we can ignore values of certain types of collateralized warp routes,
    // e.g. Native warp routes on rollups that have been pre-funded.
    const coinGeckoId = token.coinGeckoId;

    if (!coinGeckoId) {
      logger.warn('CoinGecko ID missing for token', token.symbol);
      return undefined;
    }

    return this.getCoingeckoPrice(coinGeckoId);
  }

  async getCoingeckoPrice(coingeckoId: string): Promise<number | undefined> {
    const prices = await this.getTokenPriceByIds([coingeckoId]);
    if (!prices) return undefined;
    return prices[0];
  }

  static async getCoinGeckoApiKey(): Promise<string | undefined> {
    // TODO: migrate/replicate gCloud from infra
    // const environment = 'mainnet3';
    let apiKey: string | undefined;
    try {
      // apiKey = (await fetchGCPSecret(
      //   `${environment}-coingecko-api-key`,
      //   false,
      // )) as string;
    } catch (e) {
      logger.error(
        'Error fetching CoinGecko API key, proceeding with public tier',
        e,
      );
    }

    return apiKey;
  }
}

function formatBigInt(warpToken: Token, num: bigint): number {
  return warpToken.amount(num).getDecimalFormattedAmount();
}
