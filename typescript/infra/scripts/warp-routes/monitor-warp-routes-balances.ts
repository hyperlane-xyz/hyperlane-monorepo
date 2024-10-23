import { SystemProgram } from '@solana/web3.js';
import { ethers } from 'ethers';
import { Gauge, Registry } from 'prom-client';

import {
  HypXERC20Lockbox__factory,
  HypXERC20__factory,
  IXERC20,
  IXERC20__factory,
} from '@hyperlane-xyz/core';
import { ERC20__factory } from '@hyperlane-xyz/core';
import { createWarpRouteConfigId } from '@hyperlane-xyz/registry';
import {
  ChainMap,
  ChainMetadata,
  ChainName,
  CoinGeckoTokenPriceGetter,
  CosmNativeTokenAdapter,
  CwNativeTokenAdapter,
  MultiProtocolProvider,
  SealevelHypCollateralAdapter,
  SealevelHypNativeAdapter,
  SealevelHypSyntheticAdapter,
  TokenType,
  WarpRouteConfig,
  WarpRouteConfigSchema,
} from '@hyperlane-xyz/sdk';
import {
  ProtocolType,
  objMap,
  promiseObjAll,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { startMetricsServer } from '../../src/utils/metrics.js';
import { readYaml } from '../../src/utils/utils.js';
import { getArgs } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

const logger = rootLogger.child({ module: 'warp-balance-monitor' });

const metricsRegister = new Registry();

interface WarpRouteMetrics {
  chain_name: ChainName;
  token_address: string;
  token_name: string;
  wallet_address: string;
  token_type: TokenType;
  warp_route_id: string;
  related_chain_names: string;
}

type WarpRouteMetricLabels = keyof WarpRouteMetrics;

const warpRouteMetricLabels: WarpRouteMetricLabels[] = [
  'chain_name',
  'token_address',
  'token_name',
  'wallet_address',
  'token_type',
  'warp_route_id',
  'related_chain_names',
];

const warpRouteTokenBalance = new Gauge({
  name: 'hyperlane_warp_route_token_balance',
  help: 'HypERC20 token balance of a Warp Route',
  registers: [metricsRegister],
  labelNames: warpRouteMetricLabels,
});

const warpRouteCollateralValue = new Gauge({
  name: 'hyperlane_warp_route_collateral_value',
  help: 'Total value of collateral held in a HypERC20Collateral or HypNative contract of a Warp Route',
  registers: [metricsRegister],
  labelNames: warpRouteMetricLabels,
});

const xERC20LimitsGauge = new Gauge({
  name: 'hyperlane_xerc20_limits',
  help: 'Current minting and burning limits of xERC20 tokens',
  registers: [metricsRegister],
  labelNames: ['chain_name', 'limit_type', 'token_name'],
});

interface xERC20Limit {
  tokenName: string;
  mint: number;
  burn: number;
  mintMax: number;
  burnMax: number;
}

interface WarpRouteInfo {
  balance: number;
  valueUSD?: number;
}

export function readWarpRouteConfig(filePath: string) {
  const config = readYaml(filePath);
  if (!config) throw new Error(`No warp config found at ${filePath}`);
  const result = WarpRouteConfigSchema.safeParse(config);
  if (!result.success) {
    const errorMessages = result.error.issues.map(
      (issue: any) => `${issue.path} => ${issue.message}`,
    );
    throw new Error(`Invalid warp config:\n ${errorMessages.join('\n')}`);
  }
  return result.data;
}

async function main(): Promise<boolean> {
  const { checkFrequency, filePath, environment } = await getArgs()
    .describe('checkFrequency', 'frequency to check balances in ms')
    .demandOption('checkFrequency')
    .alias('v', 'checkFrequency') // v as in Greek letter nu
    .number('checkFrequency')
    .alias('f', 'filePath')
    .describe(
      'filePath',
      'indicate the filepatch to the warp route yaml file relative to typescript/infra',
    )
    .demandOption('filePath')
    .string('filePath')
    .parse();

  startMetricsServer(metricsRegister);

  const tokenConfig: WarpRouteConfig =
    readWarpRouteConfig(filePath).data.config;

  const envConfig = getEnvironmentConfig(environment);
  const registry = await envConfig.getRegistry();
  const chainMetadata = await registry.getMetadata();

  await checkWarpRouteMetrics(checkFrequency, tokenConfig, chainMetadata);

  return true;
}

// TODO: see issue https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/2708
async function checkBalance(
  tokenConfig: WarpRouteConfig,
  multiProtocolProvider: MultiProtocolProvider,
  tokenPriceGetter: CoinGeckoTokenPriceGetter,
): Promise<ChainMap<WarpRouteInfo>> {
  const output = objMap(
    tokenConfig,
    async (chain: ChainName, token: WarpRouteConfig[ChainName]) => {
      switch (token.type) {
        case TokenType.native: {
          switch (token.protocolType) {
            case ProtocolType.Ethereum: {
              const provider = multiProtocolProvider.getEthersV5Provider(chain);
              const nativeBalance = await provider.getBalance(token.hypAddress);

              return getNativeTokenWarpInfo(
                nativeBalance,
                token.decimals,
                tokenPriceGetter,
                chain,
              );
            }
            case ProtocolType.Sealevel: {
              const adapter = new SealevelHypNativeAdapter(
                chain,
                multiProtocolProvider,
                {
                  token: token.tokenAddress,
                  warpRouter: token.hypAddress,
                  // Mailbox only required for transfers, using system as placeholder
                  mailbox: SystemProgram.programId.toBase58(),
                },
                // Not used for native tokens, but required for the adapter
                token?.isSpl2022 ?? false,
              );
              const balance = ethers.BigNumber.from(
                await adapter.getBalance(token.hypAddress),
              );

              return getNativeTokenWarpInfo(
                balance,
                token.decimals,
                tokenPriceGetter,
                chain,
              );
            }
            case ProtocolType.Cosmos: {
              if (!token.ibcDenom)
                throw new Error('IBC denom missing for native token');
              const adapter = new CosmNativeTokenAdapter(
                chain,
                multiProtocolProvider,
                {},
                { ibcDenom: token.ibcDenom },
              );
              const tokenBalance = await adapter.getBalance(token.hypAddress);

              return getNativeTokenWarpInfo(
                tokenBalance,
                token.decimals,
                tokenPriceGetter,
                chain,
              );
            }
          }
          break;
        }
        case TokenType.collateral: {
          switch (token.protocolType) {
            case ProtocolType.Ethereum: {
              const provider = multiProtocolProvider.getEthersV5Provider(chain);
              if (!token.tokenAddress)
                throw new Error('Token address missing for collateral token');
              const tokenContract = ERC20__factory.connect(
                token.tokenAddress,
                provider,
              );
              const collateralBalance = await tokenContract.balanceOf(
                token.hypAddress,
              );

              return getCollateralTokenWarpInfo(
                collateralBalance,
                token.decimals,
                tokenPriceGetter,
                token.tokenCoingeckoId,
              );
            }
            case ProtocolType.Sealevel: {
              if (!token.tokenAddress)
                throw new Error('Token address missing for collateral token');
              const adapter = new SealevelHypCollateralAdapter(
                chain,
                multiProtocolProvider,
                {
                  token: token.tokenAddress,
                  warpRouter: token.hypAddress,
                  // Mailbox only required for transfers, using system as placeholder
                  mailbox: SystemProgram.programId.toBase58(),
                },
                token?.isSpl2022 ?? false,
              );
              const collateralBalance = ethers.BigNumber.from(
                await adapter.getBalance(token.hypAddress),
              );

              return getCollateralTokenWarpInfo(
                collateralBalance,
                token.decimals,
                tokenPriceGetter,
                token.tokenCoingeckoId,
              );
            }
            case ProtocolType.Cosmos: {
              if (!token.tokenAddress)
                throw new Error('Token address missing for cosmos token');
              const adapter = new CwNativeTokenAdapter(
                chain,
                multiProtocolProvider,
                {
                  token: token.hypAddress,
                },
                token.tokenAddress,
              );
              const collateralBalance = ethers.BigNumber.from(
                await adapter.getBalance(token.hypAddress),
              );

              return getCollateralTokenWarpInfo(
                collateralBalance,
                token.decimals,
                tokenPriceGetter,
                token.tokenCoingeckoId,
              );
            }
          }
          break;
        }
        case TokenType.synthetic: {
          switch (token.protocolType) {
            case ProtocolType.Ethereum: {
              const provider = multiProtocolProvider.getEthersV5Provider(chain);
              const tokenContract = ERC20__factory.connect(
                token.hypAddress,
                provider,
              );
              const syntheticBalance = await tokenContract.totalSupply();
              return {
                balance: parseFloat(
                  ethers.utils.formatUnits(syntheticBalance, token.decimals),
                ),
              };
            }
            case ProtocolType.Sealevel: {
              if (!token.tokenAddress)
                throw new Error('Token address missing for synthetic token');
              const adapter = new SealevelHypSyntheticAdapter(
                chain,
                multiProtocolProvider,
                {
                  token: token.tokenAddress,
                  warpRouter: token.hypAddress,
                  // Mailbox only required for transfers, using system as placeholder
                  mailbox: SystemProgram.programId.toBase58(),
                },
                token?.isSpl2022 ?? false,
              );
              const syntheticBalance = ethers.BigNumber.from(
                await adapter.getTotalSupply(),
              );
              return {
                balance: parseFloat(
                  ethers.utils.formatUnits(syntheticBalance, token.decimals),
                ),
              };
            }
            case ProtocolType.Cosmos:
              // TODO - cosmos synthetic
              return { balance: 0 };
          }
          break;
        }
        case TokenType.XERC20: {
          switch (token.protocolType) {
            case ProtocolType.Ethereum: {
              const provider = multiProtocolProvider.getEthersV5Provider(chain);
              const hypXERC20 = HypXERC20__factory.connect(
                token.hypAddress,
                provider,
              );
              const xerc20Address = await hypXERC20.wrappedToken();
              const xerc20 = IXERC20__factory.connect(xerc20Address, provider);
              const syntheticBalance = await xerc20.totalSupply();

              return {
                balance: parseFloat(
                  ethers.utils.formatUnits(syntheticBalance, token.decimals),
                ),
              };
            }
            default:
              throw new Error(
                `Unsupported protocol type ${token.protocolType} for token type ${token.type}`,
              );
          }
        }
        case TokenType.XERC20Lockbox: {
          switch (token.protocolType) {
            case ProtocolType.Ethereum: {
              if (!token.tokenAddress)
                throw new Error(
                  'Token address missing for xERC20Lockbox token',
                );
              const provider = multiProtocolProvider.getEthersV5Provider(chain);
              const hypXERC20Lockbox = HypXERC20Lockbox__factory.connect(
                token.hypAddress,
                provider,
              );
              const xerc20LockboxAddress = await hypXERC20Lockbox.lockbox();
              const tokenContract = ERC20__factory.connect(
                token.tokenAddress,
                provider,
              );

              const collateralBalance = await tokenContract.balanceOf(
                xerc20LockboxAddress,
              );

              return getCollateralTokenWarpInfo(
                collateralBalance,
                token.decimals,
                tokenPriceGetter,
                token.tokenCoingeckoId,
              );
            }
            default:
              throw new Error(
                `Unsupported protocol type ${token.protocolType} for token type ${token.type}`,
              );
          }
        }
      }
      return { balance: 0 };
    },
  );

  return promiseObjAll(output);
}

export function updateTokenBalanceMetrics(
  tokenConfig: WarpRouteConfig,
  balances: ChainMap<WarpRouteInfo>,
) {
  objMap(tokenConfig, (chain: ChainName, token: WarpRouteConfig[ChainName]) => {
    const metrics: WarpRouteMetrics = {
      chain_name: chain,
      token_address: token.tokenAddress ?? ethers.constants.AddressZero,
      token_name: token.name,
      wallet_address: token.hypAddress,
      token_type: token.type,
      warp_route_id: createWarpRouteConfigId(
        token.symbol,
        Object.keys(tokenConfig) as ChainName[],
      ),
      related_chain_names: Object.keys(tokenConfig)
        .filter((c) => c !== chain)
        .join(','),
    };

    warpRouteTokenBalance.labels(metrics).set(balances[chain].balance);
    if (balances[chain].valueUSD) {
      warpRouteCollateralValue
        .labels(metrics)
        .set(balances[chain].valueUSD as number);
      logger.debug('Collateral value updated for chain', {
        chain,
        related_chain_names: metrics.related_chain_names,
        warp_route_id: metrics.warp_route_id,
        token: metrics.token_name,
        value: balances[chain].valueUSD,
      });
    }
    logger.debug('Wallet balance updated for chain', {
      chain,
      related_chain_names: metrics.related_chain_names,
      warp_route_id: metrics.warp_route_id,
      token: metrics.token_name,
      balance: balances[chain].balance,
    });
  });
}

export function updateXERC20LimitsMetrics(
  xERC20Limits: ChainMap<xERC20Limit | undefined>,
) {
  objMap(xERC20Limits, (chain: ChainName, limits: xERC20Limit | undefined) => {
    if (limits) {
      xERC20LimitsGauge
        .labels({
          chain_name: chain,
          limit_type: 'mint',
          token_name: limits.tokenName,
        })
        .set(limits.mint);
      xERC20LimitsGauge
        .labels({
          chain_name: chain,
          limit_type: 'burn',
          token_name: limits.tokenName,
        })
        .set(limits.burn);
      xERC20LimitsGauge
        .labels({
          chain_name: chain,
          limit_type: 'mintMax',
          token_name: limits.tokenName,
        })
        .set(limits.mintMax);
      xERC20LimitsGauge
        .labels({
          chain_name: chain,
          limit_type: 'burnMax',
          token_name: limits.tokenName,
        })
        .set(limits.burnMax);
      logger.info('xERC20 limits updated for chain', {
        chain,
        limits,
      });
    }
  });
}

async function getXERC20Limits(
  tokenConfig: WarpRouteConfig,
  chainMetadata: ChainMap<ChainMetadata>,
): Promise<ChainMap<xERC20Limit | undefined>> {
  const multiProtocolProvider = new MultiProtocolProvider(chainMetadata);

  const output = objMap(
    tokenConfig,
    async (chain: ChainName, token: WarpRouteConfig[ChainName]) => {
      switch (token.protocolType) {
        case ProtocolType.Ethereum: {
          switch (token.type) {
            case TokenType.XERC20Lockbox: {
              const provider = multiProtocolProvider.getEthersV5Provider(chain);
              const routerAddress = token.hypAddress;
              const lockbox = HypXERC20Lockbox__factory.connect(
                token.hypAddress,
                provider,
              );
              const xerc20Address = await lockbox.xERC20();
              const xerc20 = IXERC20__factory.connect(xerc20Address, provider);
              return getXERC20Limit(
                routerAddress,
                xerc20,
                token.decimals,
                token.name,
              );
            }
            case TokenType.XERC20: {
              const provider = multiProtocolProvider.getEthersV5Provider(chain);
              const routerAddress = token.hypAddress;
              const hypXERC20 = HypXERC20__factory.connect(
                routerAddress,
                provider,
              );
              const xerc20Address = await hypXERC20.wrappedToken();
              const xerc20 = IXERC20__factory.connect(xerc20Address, provider);
              return getXERC20Limit(
                routerAddress,
                xerc20,
                token.decimals,
                token.name,
              );
            }
            default:
              logger.info(
                `Unsupported token type ${token.type} for xERC20 limits check on protocol type ${token.protocolType}`,
              );

              return undefined;
          }
        }
        default:
          throw new Error(`Unsupported protocol type ${token.protocolType}`);
      }
    },
  );

  return promiseObjAll(output);
}

const getXERC20Limit = async (
  routerAddress: string,
  xerc20: IXERC20,
  decimals: number,
  tokenName: string,
): Promise<xERC20Limit> => {
  const mintCurrent = await xerc20.mintingCurrentLimitOf(routerAddress);
  const mintMax = await xerc20.mintingMaxLimitOf(routerAddress);
  const burnCurrent = await xerc20.burningCurrentLimitOf(routerAddress);
  const burnMax = await xerc20.burningMaxLimitOf(routerAddress);
  return {
    tokenName,
    mint: parseFloat(ethers.utils.formatUnits(mintCurrent, decimals)),
    mintMax: parseFloat(ethers.utils.formatUnits(mintMax, decimals)),
    burn: parseFloat(ethers.utils.formatUnits(burnCurrent, decimals)),
    burnMax: parseFloat(ethers.utils.formatUnits(burnMax, decimals)),
  };
};

async function getTokenPriceByChain(
  chain: ChainName,
  tokenPriceGetter: CoinGeckoTokenPriceGetter,
): Promise<number | undefined> {
  try {
    return await tokenPriceGetter.getTokenPrice(chain);
  } catch (e) {
    logger.warn('Error getting token price', e);
    return undefined;
  }
}

async function getNativeTokenValue(
  chain: ChainName,
  balanceFloat: number,
  tokenPriceGetter: CoinGeckoTokenPriceGetter,
): Promise<number | undefined> {
  const price = await getTokenPriceByChain(chain, tokenPriceGetter);
  logger.debug(`${chain} native token price ${price}`);
  if (!price) return undefined;
  return balanceFloat * price;
}

async function getNativeTokenWarpInfo(
  balance: ethers.BigNumber | bigint,
  decimal: number,
  tokenPriceGetter: CoinGeckoTokenPriceGetter,
  chain: ChainName,
): Promise<WarpRouteInfo> {
  const balanceFloat = parseFloat(ethers.utils.formatUnits(balance, decimal));
  const value = await getNativeTokenValue(
    chain,
    balanceFloat,
    tokenPriceGetter,
  );
  return { balance: balanceFloat, valueUSD: value };
}

async function getCollateralTokenPrice(
  tokenCoingeckoId: string | undefined,
  tokenPriceGetter: CoinGeckoTokenPriceGetter,
): Promise<number | undefined> {
  if (!tokenCoingeckoId) return undefined;
  const prices = await tokenPriceGetter.getTokenPriceByIds([tokenCoingeckoId]);
  if (!prices) return undefined;
  return prices[0];
}

async function getCollateralTokenValue(
  tokenCoingeckoId: string | undefined,
  balanceFloat: number,
  tokenPriceGetter: CoinGeckoTokenPriceGetter,
): Promise<number | undefined> {
  const price = await getCollateralTokenPrice(
    tokenCoingeckoId,
    tokenPriceGetter,
  );
  logger.debug(`${tokenCoingeckoId} token price ${price ? price : undefined}`);
  if (!price) return undefined;
  return balanceFloat * price;
}

async function getCollateralTokenWarpInfo(
  balance: ethers.BigNumber | bigint,
  decimal: number,
  tokenPriceGetter: CoinGeckoTokenPriceGetter,
  tokenCoingeckoId?: string,
): Promise<WarpRouteInfo> {
  const balanceFloat = parseFloat(ethers.utils.formatUnits(balance, decimal));
  const value = await getCollateralTokenValue(
    tokenCoingeckoId,
    balanceFloat,
    tokenPriceGetter,
  );
  return { balance: balanceFloat, valueUSD: value };
}

async function checkWarpRouteMetrics(
  checkFrequency: number,
  tokenConfig: WarpRouteConfig,
  chainMetadata: ChainMap<ChainMetadata>,
) {
  const tokenPriceGetter =
    CoinGeckoTokenPriceGetter.withDefaultCoinGecko(chainMetadata);

  setInterval(async () => {
    try {
      const multiProtocolProvider = new MultiProtocolProvider(chainMetadata);
      const balances = await checkBalance(
        tokenConfig,
        multiProtocolProvider,
        tokenPriceGetter,
      );
      logger.info('Token Balances:', balances);
      updateTokenBalanceMetrics(tokenConfig, balances);
    } catch (e) {
      logger.error('Error checking balances', e);
    }

    // only check xERC20 limits if there are xERC20 tokens in the config
    if (
      Object.keys(tokenConfig).some(
        (chain) =>
          tokenConfig[chain].type === TokenType.XERC20 ||
          tokenConfig[chain].type === TokenType.XERC20Lockbox,
      )
    ) {
      try {
        const xERC20Limits = await getXERC20Limits(tokenConfig, chainMetadata);
        logger.info('xERC20 Limits:', xERC20Limits);
        updateXERC20LimitsMetrics(xERC20Limits);
      } catch (e) {
        logger.error('Error checking xERC20 limits', e);
      }
    }
  }, checkFrequency);
}

main().then(logger.info).catch(logger.error);
