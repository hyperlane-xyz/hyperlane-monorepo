import { SystemProgram } from '@solana/web3.js';
import { PopulatedTransaction, ethers } from 'ethers';
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
  EvmHypXERC20Adapter,
  EvmHypXERC20LockboxAdapter,
  IHypXERC20Adapter,
  MultiProtocolProvider,
  SealevelHypCollateralAdapter,
  SealevelHypNativeAdapter,
  SealevelHypSyntheticAdapter,
  Token,
  TokenStandard,
  TokenType,
  WarpCore,
  WarpCoreConfig,
  WarpCoreConfigSchema,
  WarpRouteConfig,
  WarpRouteConfigSchema,
} from '@hyperlane-xyz/sdk';
import {
  ProtocolType,
  objMap,
  objMerge,
  promiseObjAll,
  rootLogger,
} from '@hyperlane-xyz/utils';

import {
  DeployEnvironment,
  getRouterConfigsForAllVms,
} from '../../src/config/environment.js';
import { fetchGCPSecret } from '../../src/utils/gcloud.js';
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

export function readWarpRouteConfig(filePath: string): WarpCoreConfig {
  const config = readYaml(filePath);
  if (!config) throw new Error(`No warp config found at ${filePath}`);
  const result = WarpCoreConfigSchema.safeParse(config);
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

  const warpCoreConfig = readWarpRouteConfig(filePath);

  const envConfig = getEnvironmentConfig(environment);
  const registry = await envConfig.getRegistry();
  const chainMetadata = await registry.getMetadata();

  // The Sealevel warp adapters require the Mailbox address, so we
  // get router configs (that include the Mailbox address) for all chains
  // and merge them with the chain metadata.
  const routerConfig = await getRouterConfigsForAllVms(
    envConfig,
    await envConfig.getMultiProvider(),
  );
  const multiProtocolProvider = new MultiProtocolProvider(
    objMerge(chainMetadata, routerConfig),
  );
  const warpCore = WarpCore.FromConfig(multiProtocolProvider, warpCoreConfig);

  await pollAndUpdateTokenMetrics(checkFrequency, warpCore, chainMetadata);

  return true;
}

async function getBridgedBalanceAndValue(
  warpCore: WarpCore,
  token: Token,
  _tokenPriceGetter: CoinGeckoTokenPriceGetter,
): Promise<WarpRouteInfo> {
  const bridgedSupply = await token.getBridgedSupply(warpCore.multiProvider);
  if (!bridgedSupply) {
    logger.warn('Bridged supply not found for token', token);
    return { balance: 0 };
  }

  return {
    balance: bridgedSupply.getDecimalFormattedAmount(),
    // TODO get value
  };
}

// TODO: see issue https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/2708
async function checkBalance1(
  warpCoreConfig: WarpCoreConfig,
  multiProtocolProvider: MultiProtocolProvider,
  tokenPriceGetter: CoinGeckoTokenPriceGetter,
): Promise<ChainMap<WarpRouteInfo>> {
  // const output = objMap(
  //   warpCoreConfig.tokens,
  //   async (chain: ChainName, token: WarpRouteConfig[ChainName]) => {
  //     switch (token.type) {
  //       case TokenType.native: {
  //         switch (token.protocolType) {
  //           case ProtocolType.Ethereum: {
  //             const provider = multiProtocolProvider.getEthersV5Provider(chain);
  //             const nativeBalance = await provider.getBalance(token.hypAddress);

  //             return getNativeTokenWarpInfo(
  //               nativeBalance,
  //               token.decimals,
  //               tokenPriceGetter,
  //               chain,
  //             );
  //           }
  //           case ProtocolType.Sealevel: {
  //             const adapter = new SealevelHypNativeAdapter(
  //               chain,
  //               multiProtocolProvider,
  //               {
  //                 token: token.tokenAddress,
  //                 warpRouter: token.hypAddress,
  //                 // Mailbox only required for transfers, using system as placeholder
  //                 mailbox: SystemProgram.programId.toBase58(),
  //               },
  //               // Not used for native tokens, but required for the adapter
  //               token?.isSpl2022 ?? false,
  //             );
  //             const balance = ethers.BigNumber.from(
  //               await adapter.getBalance(token.hypAddress),
  //             );

  //             return getNativeTokenWarpInfo(
  //               balance,
  //               token.decimals,
  //               tokenPriceGetter,
  //               chain,
  //             );
  //           }
  //           case ProtocolType.Cosmos: {
  //             if (!token.ibcDenom)
  //               throw new Error('IBC denom missing for native token');
  //             const adapter = new CosmNativeTokenAdapter(
  //               chain,
  //               multiProtocolProvider,
  //               {},
  //               { ibcDenom: token.ibcDenom },
  //             );
  //             const tokenBalance = await adapter.getBalance(token.hypAddress);

  //             return getNativeTokenWarpInfo(
  //               tokenBalance,
  //               token.decimals,
  //               tokenPriceGetter,
  //               chain,
  //             );
  //           }
  //         }
  //         break;
  //       }
  //       case TokenType.collateral: {
  //         switch (token.protocolType) {
  //           case ProtocolType.Ethereum: {
  //             const provider = multiProtocolProvider.getEthersV5Provider(chain);
  //             if (!token.tokenAddress)
  //               throw new Error('Token address missing for collateral token');
  //             const tokenContract = ERC20__factory.connect(
  //               token.tokenAddress,
  //               provider,
  //             );
  //             const collateralBalance = await tokenContract.balanceOf(
  //               token.hypAddress,
  //             );

  //             return getCollateralTokenWarpInfo(
  //               collateralBalance,
  //               token.decimals,
  //               tokenPriceGetter,
  //               token.tokenCoinGeckoId,
  //             );
  //           }
  //           case ProtocolType.Sealevel: {
  //             if (!token.tokenAddress)
  //               throw new Error('Token address missing for collateral token');
  //             const adapter = new SealevelHypCollateralAdapter(
  //               chain,
  //               multiProtocolProvider,
  //               {
  //                 token: token.tokenAddress,
  //                 warpRouter: token.hypAddress,
  //                 // Mailbox only required for transfers, using system as placeholder
  //                 mailbox: SystemProgram.programId.toBase58(),
  //               },
  //               token?.isSpl2022 ?? false,
  //             );
  //             const collateralBalance = ethers.BigNumber.from(
  //               await adapter.getBalance(token.hypAddress),
  //             );

  //             return getCollateralTokenWarpInfo(
  //               collateralBalance,
  //               token.decimals,
  //               tokenPriceGetter,
  //               token.tokenCoinGeckoId,
  //             );
  //           }
  //           case ProtocolType.Cosmos: {
  //             if (!token.tokenAddress)
  //               throw new Error('Token address missing for cosmos token');
  //             const adapter = new CwNativeTokenAdapter(
  //               chain,
  //               multiProtocolProvider,
  //               {
  //                 token: token.hypAddress,
  //               },
  //               token.tokenAddress,
  //             );
  //             const collateralBalance = ethers.BigNumber.from(
  //               await adapter.getBalance(token.hypAddress),
  //             );

  //             return getCollateralTokenWarpInfo(
  //               collateralBalance,
  //               token.decimals,
  //               tokenPriceGetter,
  //               token.tokenCoinGeckoId,
  //             );
  //           }
  //         }
  //         break;
  //       }
  //       case TokenType.synthetic: {
  //         switch (token.protocolType) {
  //           case ProtocolType.Ethereum: {
  //             const provider = multiProtocolProvider.getEthersV5Provider(chain);
  //             const tokenContract = ERC20__factory.connect(
  //               token.hypAddress,
  //               provider,
  //             );
  //             const syntheticBalance = await tokenContract.totalSupply();
  //             return {
  //               balance: parseFloat(
  //                 ethers.utils.formatUnits(syntheticBalance, token.decimals),
  //               ),
  //             };
  //           }
  //           case ProtocolType.Sealevel: {
  //             if (!token.tokenAddress)
  //               throw new Error('Token address missing for synthetic token');
  //             const adapter = new SealevelHypSyntheticAdapter(
  //               chain,
  //               multiProtocolProvider,
  //               {
  //                 token: token.tokenAddress,
  //                 warpRouter: token.hypAddress,
  //                 // Mailbox only required for transfers, using system as placeholder
  //                 mailbox: SystemProgram.programId.toBase58(),
  //               },
  //               token?.isSpl2022 ?? false,
  //             );
  //             const syntheticBalance = ethers.BigNumber.from(
  //               await adapter.getTotalSupply(),
  //             );
  //             return {
  //               balance: parseFloat(
  //                 ethers.utils.formatUnits(syntheticBalance, token.decimals),
  //               ),
  //             };
  //           }
  //           case ProtocolType.Cosmos:
  //             // TODO - cosmos synthetic
  //             return { balance: 0 };
  //         }
  //         break;
  //       }
  //       case TokenType.XERC20: {
  //         switch (token.protocolType) {
  //           case ProtocolType.Ethereum: {
  //             const provider = multiProtocolProvider.getEthersV5Provider(chain);
  //             const hypXERC20 = HypXERC20__factory.connect(
  //               token.hypAddress,
  //               provider,
  //             );
  //             const xerc20Address = await hypXERC20.wrappedToken();
  //             const xerc20 = IXERC20__factory.connect(xerc20Address, provider);
  //             const syntheticBalance = await xerc20.totalSupply();

  //             return {
  //               balance: parseFloat(
  //                 ethers.utils.formatUnits(syntheticBalance, token.decimals),
  //               ),
  //             };
  //           }
  //           default:
  //             throw new Error(
  //               `Unsupported protocol type ${token.protocolType} for token type ${token.type}`,
  //             );
  //         }
  //       }
  //       case TokenType.XERC20Lockbox: {
  //         switch (token.protocolType) {
  //           case ProtocolType.Ethereum: {
  //             if (!token.tokenAddress)
  //               throw new Error(
  //                 'Token address missing for xERC20Lockbox token',
  //               );
  //             const provider = multiProtocolProvider.getEthersV5Provider(chain);
  //             const hypXERC20Lockbox = HypXERC20Lockbox__factory.connect(
  //               token.hypAddress,
  //               provider,
  //             );
  //             const xerc20LockboxAddress = await hypXERC20Lockbox.lockbox();
  //             const tokenContract = ERC20__factory.connect(
  //               token.tokenAddress,
  //               provider,
  //             );

  //             const collateralBalance = await tokenContract.balanceOf(
  //               xerc20LockboxAddress,
  //             );

  //             return getCollateralTokenWarpInfo(
  //               collateralBalance,
  //               token.decimals,
  //               tokenPriceGetter,
  //               token.tokenCoinGeckoId,
  //             );
  //           }
  //           default:
  //             throw new Error(
  //               `Unsupported protocol type ${token.protocolType} for token type ${token.type}`,
  //             );
  //         }
  //       }
  //     }
  //     return { balance: 0 };
  //   },
  // );

  // return promiseObjAll(output);
  return {};
}

export function updateTokenBalanceMetrics(
  warpCore: WarpCore,
  token: Token,
  balanceInfo: WarpRouteInfo,
) {
  const metrics: WarpRouteMetrics = {
    chain_name: token.chainName,
    // TODO better way ?
    token_address: token.collateralAddressOrDenom || token.addressOrDenom,
    token_name: token.name,
    // TODO better way?
    wallet_address: token.addressOrDenom,
    // TODO can we go standard => type?
    // @ts-ignore
    token_type: token.standard,
    warp_route_id: createWarpRouteConfigId(
      token.symbol,
      warpCore.getTokenChains(),
    ),
    related_chain_names: warpCore
      .getTokenChains()
      .filter((chainName) => chainName !== token.chainName)
      .sort()
      .join(','),
  };

  warpRouteTokenBalance.labels(metrics).set(balanceInfo.balance);
  if (balanceInfo.valueUSD) {
    warpRouteCollateralValue.labels(metrics).set(balanceInfo.valueUSD);
    logger.debug('Collateral value updated for chain', {
      chain: token.chainName,
      related_chain_names: metrics.related_chain_names,
      warp_route_id: metrics.warp_route_id,
      token: metrics.token_name,
      value: balanceInfo.valueUSD,
      token_type: token.standard,
    });
  }
  logger.debug('Wallet balance updated for chain', {
    chain: token.chainName,
    related_chain_names: metrics.related_chain_names,
    warp_route_id: metrics.warp_route_id,
    token: metrics.token_name,
    value: balanceInfo.balance,
    token_type: token.standard,
  });
}

export function updateXERC20LimitsMetrics(token: Token, limits: xERC20Limit) {
  const chain = token.chainName;
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

async function getXERC20Limits(
  warpCore: WarpCore,
  token: Token,
): Promise<xERC20Limit> {
  if (token.protocol !== ProtocolType.Ethereum) {
    throw new Error(`Unsupported XERC20 protocol type ${token.protocol}`);
  }

  if (token.standard === TokenStandard.EvmHypXERC20) {
    const adapter = token.getAdapter(
      warpCore.multiProvider,
    ) as EvmHypXERC20Adapter;
    return getXERC20Limit(token, adapter);
  } else if (token.standard === TokenStandard.EvmHypXERC20Lockbox) {
    const adapter = token.getAdapter(
      warpCore.multiProvider,
    ) as EvmHypXERC20LockboxAdapter;
    return getXERC20Limit(token, adapter);
  }
  throw new Error(`Unsupported XERC20 token standard ${token.standard}`);

  // const output = objMap(
  //   tokenConfig,
  //   async (chain: ChainName, token: WarpRouteConfig[ChainName]) => {
  //     switch (token.protocolType) {
  //       case ProtocolType.Ethereum: {
  //         switch (token.type) {
  //           case TokenType.XERC20Lockbox: {
  //             const provider = multiProtocolProvider.getEthersV5Provider(chain);
  //             const routerAddress = token.hypAddress;
  //             const lockbox = HypXERC20Lockbox__factory.connect(
  //               token.hypAddress,
  //               provider,
  //             );
  //             const xerc20Address = await lockbox.xERC20();
  //             const xerc20 = IXERC20__factory.connect(xerc20Address, provider);
  //             return getXERC20Limit(
  //               routerAddress,
  //               xerc20,
  //               token.decimals,
  //               token.name,
  //             );
  //           }
  //           case TokenType.XERC20: {
  //             const provider = multiProtocolProvider.getEthersV5Provider(chain);
  //             const routerAddress = token.hypAddress;
  //             const hypXERC20 = HypXERC20__factory.connect(
  //               routerAddress,
  //               provider,
  //             );
  //             const xerc20Address = await hypXERC20.wrappedToken();
  //             const xerc20 = IXERC20__factory.connect(xerc20Address, provider);
  //             return getXERC20Limit(
  //               routerAddress,
  //               xerc20,
  //               token.decimals,
  //               token.name,
  //             );
  //           }
  //           default:
  //             logger.info(
  //               `Unsupported token type ${token.type} for xERC20 limits check on protocol type ${token.protocolType}`,
  //             );

  //             return undefined;
  //         }
  //       }
  //       default:
  //         throw new Error(`Unsupported protocol type ${token.protocolType}`);
  //     }
  //   },
  // );

  // return promiseObjAll(output);
}

async function getXERC20Limit(
  token: Token,
  xerc20: IHypXERC20Adapter<PopulatedTransaction>,
): Promise<xERC20Limit> {
  const formatBigint = (num: bigint) => {
    return token.amount(num).getDecimalFormattedAmount();
  };

  const [mintCurrent, mintMax, burnCurrent, burnMax] = await Promise.all([
    xerc20.getMintLimit(),
    xerc20.getMintMaxLimit(),
    xerc20.getBurnLimit(),
    xerc20.getBurnMaxLimit(),
  ]);

  return {
    tokenName: token.name,
    mint: formatBigint(mintCurrent),
    mintMax: formatBigint(mintMax),
    burn: formatBigint(burnCurrent),
    burnMax: formatBigint(burnMax),
  };
}

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
  tokenCoinGeckoId: string | undefined,
  tokenPriceGetter: CoinGeckoTokenPriceGetter,
): Promise<number | undefined> {
  if (!tokenCoinGeckoId) return undefined;
  const prices = await tokenPriceGetter.getTokenPriceByIds([tokenCoinGeckoId]);
  if (!prices) return undefined;
  return prices[0];
}

async function getCollateralTokenValue(
  tokenCoinGeckoId: string | undefined,
  balanceFloat: number,
  tokenPriceGetter: CoinGeckoTokenPriceGetter,
): Promise<number | undefined> {
  const price = await getCollateralTokenPrice(
    tokenCoinGeckoId,
    tokenPriceGetter,
  );
  logger.debug(`${tokenCoinGeckoId} token price ${price}`);
  if (!price) return undefined;
  return balanceFloat * price;
}

async function getCollateralTokenWarpInfo(
  balance: ethers.BigNumber | bigint,
  decimal: number,
  tokenPriceGetter: CoinGeckoTokenPriceGetter,
  tokenCoinGeckoId?: string,
): Promise<WarpRouteInfo> {
  const balanceFloat = parseFloat(ethers.utils.formatUnits(balance, decimal));
  const value = await getCollateralTokenValue(
    tokenCoinGeckoId,
    balanceFloat,
    tokenPriceGetter,
  );
  return { balance: balanceFloat, valueUSD: value };
}

async function gracefullyHandleError(fn: () => Promise<void>, context: string) {
  try {
    await fn();
  } catch (e) {
    logger.error(`Error in ${context}`, e);
  }
}

async function updateTokenMetrics(
  warpCore: WarpCore,
  token: Token,
  _tokenPriceGetter: CoinGeckoTokenPriceGetter,
) {
  const promises = [
    gracefullyHandleError(async () => {
      const balanceInfo = await getBridgedBalanceAndValue(
        warpCore,
        token,
        _tokenPriceGetter,
      );
      updateTokenBalanceMetrics(warpCore, token, balanceInfo);
    }, 'Getting bridged balance and value'),
  ];

  if (token.isXerc20()) {
    promises.push(
      gracefullyHandleError(async () => {
        const limits = await getXERC20Limits(warpCore, token);
        updateXERC20LimitsMetrics(token, limits);
      }, 'Getting xERC20 limits'),
    );
  }

  await Promise.all(promises);
}

async function pollAndUpdateTokenMetrics(
  checkFrequency: number,
  warpCore: WarpCore,
  chainMetadata: ChainMap<ChainMetadata>,
) {
  const tokenPriceGetter = CoinGeckoTokenPriceGetter.withDefaultCoinGecko(
    chainMetadata,
    await getCoinGeckoApiKey(),
  );

  setInterval(async () => {
    try {
      await Promise.all(
        warpCore.tokens.map((token) =>
          updateTokenMetrics(warpCore, token, tokenPriceGetter),
        ),
      );
      // logger.info('Token Balances:', balances);
      // updateTokenBalanceMetrics(warpCore, balances);
    } catch (e) {
      logger.error('Error checking balances', e);
    }

    // // only check xERC20 limits if there are xERC20 tokens in the config
    // if (
    //   warpCoreConfig.tokens.some(
    //     (token) =>
    //       token.standard === TokenStandard.EvmHypXERC20 ||
    //       token.standard === TokenStandard.EvmHypXERC20Lockbox,
    //   )
    // ) {
    //   try {
    //     const xERC20Limits = await getXERC20Limits(warpCoreConfig, chainMetadata);
    //     logger.info('xERC20 Limits:', xERC20Limits);
    //     updateXERC20LimitsMetrics(xERC20Limits);
    //   } catch (e) {
    //     logger.error('Error checking xERC20 limits', e);
    //   }
    // }
  }, checkFrequency);
}

async function getCoinGeckoApiKey(): Promise<string | undefined> {
  const environment: DeployEnvironment = 'mainnet3';
  let apiKey: string | undefined;
  try {
    apiKey = (await fetchGCPSecret(
      `${environment}-coingecko-api-key`,
      false,
    )) as string;
  } catch (e) {
    logger.error(
      'Error fetching CoinGecko API key, proceeding with public tier',
      e,
    );
  }

  return apiKey;
}

main().then(logger.info).catch(logger.error);
