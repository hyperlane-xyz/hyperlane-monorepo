import { SystemProgram } from '@solana/web3.js';
import { ethers } from 'ethers';
import { Gauge, Registry } from 'prom-client';
import yargs from 'yargs';

import {
  HypXERC20Lockbox__factory,
  HypXERC20__factory,
  IXERC20__factory,
} from '@hyperlane-xyz/core';
import { ERC20__factory } from '@hyperlane-xyz/core';
import {
  ChainMap,
  ChainName,
  CosmNativeTokenAdapter,
  CwNativeTokenAdapter,
  MultiProtocolProvider,
  MultiProvider,
  SealevelHypCollateralAdapter,
  TokenStandard,
  TokenType,
  WarpCoreConfig,
  WarpRouteConfig,
  WarpRouteConfigSchema,
} from '@hyperlane-xyz/sdk';
import {
  ProtocolType,
  objMap,
  promiseObjAll,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { getChainMetadata, getRegistry } from '../../config/registry.js';
import { startMetricsServer } from '../../src/utils/metrics.js';
import { readYaml } from '../../src/utils/utils.js';

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

const xERC20LimitsGauge = new Gauge({
  name: 'hyperlane_xerc20_limits',
  help: 'Current minting and burning limits of xERC20 tokens',
  registers: [metricsRegister],
  labelNames: ['chain_name', 'limit_type'],
});

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
  const { checkFrequency, filePath } = await yargs(process.argv.slice(2))
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

  await checkTokenBalances(checkFrequency, tokenConfig);

  if (
    Object.values(tokenConfig).some((token) => token.type === TokenType.XERC20)
  ) {
    await checkXERC20Limits(checkFrequency);
  }

  return true;
}

// TODO: see issue https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/2708
async function checkBalance(
  tokenConfig: WarpRouteConfig,
  multiProtocolProvider: MultiProtocolProvider,
): Promise<ChainMap<number>> {
  const output = objMap(
    tokenConfig,
    async (chain: ChainName, token: WarpRouteConfig[ChainName]) => {
      switch (token.type) {
        case TokenType.native: {
          switch (token.protocolType) {
            case ProtocolType.Ethereum: {
              const provider = multiProtocolProvider.getEthersV5Provider(chain);
              const nativeBalance = await provider.getBalance(token.hypAddress);
              return parseFloat(
                ethers.utils.formatUnits(nativeBalance, token.decimals),
              );
            }
            case ProtocolType.Sealevel:
              // TODO - solana native
              return 0;
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
              return parseFloat(
                ethers.utils.formatUnits(tokenBalance, token.decimals),
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

              return parseFloat(
                ethers.utils.formatUnits(collateralBalance, token.decimals),
              );
            }
            case ProtocolType.Sealevel: {
              if (!token.tokenAddress)
                throw new Error('Token address missing for synthetic token');
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
              return parseFloat(
                ethers.utils.formatUnits(collateralBalance, token.decimals),
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
              return parseFloat(
                ethers.utils.formatUnits(collateralBalance, token.decimals),
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
              return parseFloat(
                ethers.utils.formatUnits(syntheticBalance, token.decimals),
              );
            }
            case ProtocolType.Sealevel:
              // TODO - solana native
              return 0;
            case ProtocolType.Cosmos:
              // TODO - cosmos native
              return 0;
          }
          break;
        }
      }
      return 0;
    },
  );

  return promiseObjAll(output);
}

export function updateTokenBalanceMetrics(
  tokenConfig: WarpRouteConfig,
  balances: ChainMap<number>,
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
      .set(balances[chain]);
    logger.debug('Wallet balance updated for chain', {
      chain,
      token: token.name,
      balance: balances[chain],
    });
  });
}

export function updateXERC20LimitsMetrics(
  xERC20Limits: {
    chain: string;
    mint: number;
    burn: number;
    mintMax: number;
    burnMax: number;
  }[],
) {
  xERC20Limits.forEach((limit) => {
    xERC20LimitsGauge
      .labels({
        chain_name: limit.chain,
        limit_type: 'mint',
      })
      .set(limit.mint);
    xERC20LimitsGauge
      .labels({
        chain_name: limit.chain,
        limit_type: 'burn',
      })
      .set(limit.burn);
    xERC20LimitsGauge
      .labels({
        chain_name: limit.chain,
        limit_type: 'mintMax',
      })
      .set(limit.mintMax);
    xERC20LimitsGauge
      .labels({
        chain_name: limit.chain,
        limit_type: 'burnMax',
      })
      .set(limit.burnMax);
    logger.info('xERC20 limits updated for chain', {
      chain: limit.chain,
      mint: limit.mint,
      burn: limit.burn,
      mintMax: limit.mintMax,
      burnMax: limit.burnMax,
    });
  });
}

function getXerc20Limits(
  warpCoreConfig: WarpCoreConfig,
  multiProvider: MultiProvider,
): Promise<
  {
    chain: string;
    mint: number;
    mintMax: number;
    burn: number;
    burnMax: number;
  }[]
> {
  const result = Promise.all(
    warpCoreConfig.tokens
      .filter(
        (t) =>
          t.standard === TokenStandard.EvmHypXERC20 ||
          t.standard === TokenStandard.EvmHypXERC20Lockbox,
      )
      .map(async (t) => {
        const provider = multiProvider.getProvider(t.chainName);
        const router = t.addressOrDenom!;
        const xerc20Address =
          t.standard === TokenStandard.EvmHypXERC20Lockbox
            ? await HypXERC20Lockbox__factory.connect(router, provider).xERC20()
            : await HypXERC20__factory.connect(router, provider).wrappedToken();

        const xerc20 = IXERC20__factory.connect(xerc20Address, provider);
        const mintCurrent = await xerc20.mintingCurrentLimitOf(router);
        const mintMax = await xerc20.mintingMaxLimitOf(router);
        const burnCurrent = await xerc20.burningCurrentLimitOf(router);
        const burnMax = await xerc20.burningMaxLimitOf(router);

        return {
          chain: t.chainName,
          mint: parseFloat(ethers.utils.formatUnits(mintCurrent)),
          mintMax: parseFloat(ethers.utils.formatUnits(mintMax)),
          burn: parseFloat(ethers.utils.formatUnits(burnCurrent)),
          burnMax: parseFloat(ethers.utils.formatUnits(burnMax)),
        };
      }),
  );

  return result;
}

async function checkXERC20Limits(checkFrequency: number) {
  const registry = await getRegistry();
  const symbol = 'EZETH';
  const matching = await registry.getWarpRoutes({
    symbol,
  });

  const routes = Object.entries(matching);

  let warpCoreConfig: WarpCoreConfig;
  if (routes.length === 0) {
    logger.error(`No warp routes found for symbol ${symbol}. Exiting.`);
    process.exit(0);
  } else if (routes.length === 1) {
    warpCoreConfig = routes[0][1];
  } else {
    logger.error(`Multiple warp routes found for symbol ${symbol}. Exiting.`);
    process.exit(0);
  }

  const chainMetadata = await registry.getMetadata();
  const multiProvider = new MultiProvider(chainMetadata);

  setInterval(async () => {
    try {
      const xERC20Limits = await getXerc20Limits(warpCoreConfig, multiProvider);
      logger.info('xERC20 Limits:', xERC20Limits);
      updateXERC20LimitsMetrics(xERC20Limits);
    } catch (e) {
      logger.error('Error checking balances', e);
    }
  }, checkFrequency);
}

export async function checkTokenBalances(
  checkFrequency: number,
  tokenConfig: WarpRouteConfig,
) {
  logger.info('Starting Warp Route balance monitor');
  const multiProtocolProvider = new MultiProtocolProvider(getChainMetadata());

  setInterval(async () => {
    try {
      logger.debug('Checking balances');
      const balances = await checkBalance(tokenConfig, multiProtocolProvider);
      updateTokenBalanceMetrics(tokenConfig, balances);
    } catch (e) {
      logger.error('Error checking balances', e);
    }
  }, checkFrequency);
}

main().then(logger.info).catch(logger.error);
