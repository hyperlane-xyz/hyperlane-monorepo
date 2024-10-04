import { SystemProgram } from '@solana/web3.js';
import CoinGecko from 'coingecko-api';
import { ethers } from 'ethers';
import { Gauge, Registry } from 'prom-client';

import {
  HypXERC20Lockbox__factory,
  HypXERC20__factory,
  IXERC20,
  IXERC20__factory,
} from '@hyperlane-xyz/core';
import { ERC20__factory } from '@hyperlane-xyz/core';
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
const warpRouteTokenBalance = new Gauge({
  name: 'hyperlane_warp_route_token_balance',
  help: 'HypERC20 token balance of a Warp Route',
  registers: [metricsRegister],
  labelNames: [
    'chain_name',
    'token_address',
    'token_name',
    'wallet_address',
    'token_type',
  ],
});

const warpRouteCollateralValue = new Gauge({
  name: 'hyperlane_warp_route_collateral_value',
  help: 'Total value of collateral held in a HypERC20Collateral or HypNative contract of a Warp Route',
  registers: [metricsRegister],
  labelNames: ['chain_name', 'token_address', 'token_name'],
});

const xERC20LimitsGauge = new Gauge({
  name: 'hyperlane_xerc20_limits',
  help: 'Current minting and burning limits of xERC20 tokens',
  registers: [metricsRegister],
  labelNames: ['chain_name', 'limit_type'],
});

interface xERC20Limit {
  mint: number;
  burn: number;
  mintMax: number;
  burnMax: number;
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

  // TODO: eventually support token balance checks for xERC20 token type also
  if (
    Object.values(tokenConfig).some(
      (token) =>
        token.type === TokenType.XERC20 ||
        token.type === TokenType.XERC20Lockbox,
    )
  ) {
    await checkXERC20Limits(checkFrequency, tokenConfig, chainMetadata);
  } else {
    await checkTokenBalances(checkFrequency, tokenConfig, chainMetadata);
  }

  return true;
}

interface tokenInfo {
  balance: number;
  value?: number;
}

// TODO: see issue https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/2708
async function checkBalance(
  tokenConfig: WarpRouteConfig,
  multiProtocolProvider: MultiProtocolProvider,
  tokenPriceGetter: CoinGeckoTokenPriceGetter,
): Promise<ChainMap<tokenInfo>> {
  const output = objMap(
    tokenConfig,
    async (chain: ChainName, token: WarpRouteConfig[ChainName]) => {
      switch (token.type) {
        case TokenType.native: {
          switch (token.protocolType) {
            case ProtocolType.Ethereum: {
              const provider = multiProtocolProvider.getEthersV5Provider(chain);
              const nativeBalance = await provider.getBalance(token.hypAddress);
              const price = await tokenPriceGetter.getTokenPrice(chain);
              logger.debug('price', price);
              logger.debug('calculated value...');
              const value =
                parseFloat(
                  ethers.utils.formatUnits(nativeBalance, token.decimals),
                ) * price;
              logger.debug('Native balance', {
                chain,
                balance: parseFloat(
                  ethers.utils.formatUnits(nativeBalance, token.decimals),
                ),
                value,
              });

              return {
                balance: parseFloat(
                  ethers.utils.formatUnits(nativeBalance, token.decimals),
                ),
                value,
              };
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
              const price = await tokenPriceGetter.getTokenPrice(chain);
              const balanceFloat = parseFloat(
                ethers.utils.formatUnits(balance, token.decimals),
              );
              const nativeValue = balanceFloat * price;
              logger.debug('Native balance', {
                chain,
                balance: balanceFloat,
                price,
                value: nativeValue,
              });
              return {
                balance: balanceFloat,
                value: nativeValue,
              };
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
              return {
                balance: parseFloat(
                  ethers.utils.formatUnits(tokenBalance, token.decimals),
                ),
              };
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
              const collateralBalanceFloat = parseFloat(
                ethers.utils.formatUnits(collateralBalance, token.decimals),
              );
              let collateralValue: number | undefined = undefined;
              let collateralPrice: number | undefined = undefined;
              if (token.tokenCoinGeckoId) {
                const collateralPrices =
                  await tokenPriceGetter.getTokenPriceByIds([
                    token.tokenCoinGeckoId,
                  ]);
                collateralPrice = collateralPrices[0];
                collateralValue = collateralBalanceFloat * collateralPrice;
              }

              logger.debug('Collateral balance', {
                chain,
                balance: parseFloat(
                  ethers.utils.formatUnits(collateralBalance, token.decimals),
                ),
                price: collateralPrice,
                value: collateralValue,
              });

              return {
                balance: parseFloat(
                  ethers.utils.formatUnits(collateralBalance, token.decimals),
                ),
                value: collateralValue,
              };
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
              const collateralBalanceFloat = parseFloat(
                ethers.utils.formatUnits(collateralBalance, token.decimals),
              );
              let collateralValue: number | undefined = undefined;
              let collateralPrice: number | undefined = undefined;

              if (token.tokenCoinGeckoId) {
                const collateralPrices =
                  await tokenPriceGetter.getTokenPriceByIds([
                    token.tokenCoinGeckoId,
                  ]);
                collateralPrice = collateralPrices[0];
                collateralValue = collateralBalanceFloat * collateralPrice;
              }

              logger.debug('Collateral balance', {
                chain,
                balance: collateralBalanceFloat,
                price: collateralPrice,
                value: collateralValue,
              });
              return {
                balance: parseFloat(
                  ethers.utils.formatUnits(collateralBalance, token.decimals),
                ),
                value: collateralValue,
              };
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
              return {
                balance: parseFloat(
                  ethers.utils.formatUnits(collateralBalance, token.decimals),
                ),
              };
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
      }
      return { balance: 0 };
    },
  );

  return promiseObjAll(output);
}

export function updateTokenBalanceMetrics(
  tokenConfig: WarpRouteConfig,
  balances: ChainMap<tokenInfo>,
) {
  objMap(tokenConfig, (chain: ChainName, token: WarpRouteConfig[ChainName]) => {
    warpRouteTokenBalance
      .labels({
        chain_name: chain,
        token_address: token.tokenAddress ?? ethers.constants.AddressZero,
        token_name: token.name,
        wallet_address: token.hypAddress,
        token_type: token.type,
      })
      .set(balances[chain].balance);
    if (balances[chain].value) {
      warpRouteCollateralValue
        .labels({
          chain_name: chain,
          token_address: token.tokenAddress ?? ethers.constants.AddressZero,
          token_name: token.name,
        })
        .set(balances[chain].value as number);
    }
    logger.debug('Wallet balance updated for chain', {
      chain,
      token: token.name,
      balance: balances[chain].balance,
    });
  });
}

export function updateXERC20LimitsMetrics(xERC20Limits: ChainMap<xERC20Limit>) {
  objMap(xERC20Limits, (chain: ChainName, limit: xERC20Limit) => {
    xERC20LimitsGauge
      .labels({
        chain_name: chain,
        limit_type: 'mint',
      })
      .set(limit.mint);
    xERC20LimitsGauge
      .labels({
        chain_name: chain,
        limit_type: 'burn',
      })
      .set(limit.burn);
    xERC20LimitsGauge
      .labels({
        chain_name: chain,
        limit_type: 'mintMax',
      })
      .set(limit.mintMax);
    xERC20LimitsGauge
      .labels({
        chain_name: chain,
        limit_type: 'burnMax',
      })
      .set(limit.burnMax);
    logger.info('xERC20 limits updated for chain', {
      chain,
      mint: limit.mint,
      burn: limit.burn,
      mintMax: limit.mintMax,
      burnMax: limit.burnMax,
    });
  });
}

async function getXERC20Limits(
  tokenConfig: WarpRouteConfig,
  chainMetadata: ChainMap<ChainMetadata>,
): Promise<ChainMap<xERC20Limit>> {
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
              return getXERC20Limit(routerAddress, xerc20, token.decimals);
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
              return getXERC20Limit(routerAddress, xerc20, token.decimals);
            }
            default:
              throw new Error(`Unsupported token type ${token.type}`);
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
): Promise<xERC20Limit> => {
  const mintCurrent = await xerc20.mintingCurrentLimitOf(routerAddress);
  const mintMax = await xerc20.mintingMaxLimitOf(routerAddress);
  const burnCurrent = await xerc20.burningCurrentLimitOf(routerAddress);
  const burnMax = await xerc20.burningMaxLimitOf(routerAddress);
  return {
    mint: parseFloat(ethers.utils.formatUnits(mintCurrent, decimals)),
    mintMax: parseFloat(ethers.utils.formatUnits(mintMax, decimals)),
    burn: parseFloat(ethers.utils.formatUnits(burnCurrent, decimals)),
    burnMax: parseFloat(ethers.utils.formatUnits(burnMax, decimals)),
  };
};

async function checkXERC20Limits(
  checkFrequency: number,
  tokenConfig: WarpRouteConfig,
  chainMetadata: ChainMap<ChainMetadata>,
) {
  setInterval(async () => {
    try {
      const xERC20Limits = await getXERC20Limits(tokenConfig, chainMetadata);
      logger.info('xERC20 Limits:', xERC20Limits);
      updateXERC20LimitsMetrics(xERC20Limits);
    } catch (e) {
      logger.error('Error checking balances', e);
    }
  }, checkFrequency);
}

async function checkTokenBalances(
  checkFrequency: number,
  tokenConfig: WarpRouteConfig,
  chainMetadata: ChainMap<ChainMetadata>,
) {
  logger.info('Starting Warp Route balance monitor');
  const multiProtocolProvider = new MultiProtocolProvider(chainMetadata);
  const tokenPriceGetter = new CoinGeckoTokenPriceGetter(
    new CoinGecko(),
    chainMetadata,
  );

  setInterval(async () => {
    try {
      logger.debug('Checking balances');
      const balances = await checkBalance(
        tokenConfig,
        multiProtocolProvider,
        tokenPriceGetter,
      );
      updateTokenBalanceMetrics(tokenConfig, balances);
    } catch (e) {
      logger.error('Error checking balances', e);
    }
  }, checkFrequency);
}

main().then(logger.info).catch(logger.error);
