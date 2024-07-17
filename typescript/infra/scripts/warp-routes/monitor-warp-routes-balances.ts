import { SystemProgram } from '@solana/web3.js';
import { ethers } from 'ethers';
import { Gauge, Registry } from 'prom-client';
import yargs from 'yargs';

import {
  HypXERC20Lockbox__factory,
  HypXERC20__factory,
  IXERC20,
  IXERC20__factory,
} from '@hyperlane-xyz/core';
import { ERC20__factory } from '@hyperlane-xyz/core';
import {
  ChainMap,
  ChainName,
  CosmNativeTokenAdapter,
  CwNativeTokenAdapter,
  MultiProtocolProvider,
  SealevelHypCollateralAdapter,
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

import { getChainMetadata } from '../../config/registry.js';
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

  // TODO: eventually support token balance checks for xERC20 token type also
  if (
    Object.values(tokenConfig).some(
      (token) =>
        token.type === TokenType.XERC20 ||
        token.type === TokenType.XERC20Lockbox,
    )
  ) {
    await checkXERC20Limits(checkFrequency, tokenConfig);
  } else {
    await checkTokenBalances(checkFrequency, tokenConfig);
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
): Promise<ChainMap<xERC20Limit>> {
  const multiProtocolProvider = new MultiProtocolProvider(getChainMetadata());

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
          }
          break;
        }
      }
      return {
        chain: chain,
        mint: 0,
        mintMax: 0,
        burn: 0,
        burnMax: 0,
      };
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
) {
  setInterval(async () => {
    try {
      const xERC20Limits = await getXERC20Limits(tokenConfig);
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
