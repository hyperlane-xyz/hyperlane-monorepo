import { SystemProgram } from '@solana/web3.js';
import { ethers } from 'ethers';
import { Gauge, Registry } from 'prom-client';
import yargs from 'yargs';

import { ERC20__factory } from '@hyperlane-xyz/core';
import {
  ChainMap,
  ChainName,
  CwNativeTokenAdapter,
  MultiProtocolProvider,
  SealevelHypCollateralAdapter,
  TokenType,
} from '@hyperlane-xyz/sdk';
import {
  ProtocolType,
  debug,
  objMap,
  promiseObjAll,
} from '@hyperlane-xyz/utils';

import {
  WarpTokenConfig,
  nautilusList,
  neutronList,
} from '../../src/config/grafana_token_config';
import { startMetricsServer } from '../../src/utils/metrics';

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

async function main(): Promise<boolean> {
  const { checkFrequency, config } = await yargs(process.argv.slice(2))
    .describe('checkFrequency', 'frequency to check balances in ms')
    .demandOption('checkFrequency')
    .alias('l', 'checkFrequency')
    .number('checkFrequency')
    .alias('c', 'config')
    .describe('config', 'choose warp token config')
    .demandOption('config')
    .choices('config', ['neutron', 'nautilus'])
    .parse();

  const tokenList: WarpTokenConfig =
    config === 'neutron' ? neutronList : nautilusList;

  startMetricsServer(metricsRegister);

  console.log('Starting Warp Route balance monitor');
  const multiProtocolProvider = new MultiProtocolProvider();

  setInterval(async () => {
    try {
      debug('Checking balances');
      const balances = await checkBalance(tokenList, multiProtocolProvider);
      updateTokenBalanceMetrics(tokenList, balances);
    } catch (e) {
      console.error('Error checking balances', e);
    }
  }, checkFrequency);
  return true;
}

// TODO: see issue https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/2708
async function checkBalance(
  tokenConfig: WarpTokenConfig,
  multiProtocolProvider: MultiProtocolProvider,
): Promise<ChainMap<number>> {
  const output: ChainMap<Promise<number>> = objMap(
    tokenConfig,
    async (chain: ChainName, token: WarpTokenConfig[ChainName]) => {
      switch (token.type) {
        case TokenType.native: {
          switch (token.protocolType) {
            case ProtocolType.Ethereum: {
              const provider = multiProtocolProvider.getEthersV5Provider(chain);
              const nativeBalance = await provider.getBalance(
                token.hypNativeAddress,
              );
              return parseFloat(
                ethers.utils.formatUnits(nativeBalance, token.decimals),
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
        case TokenType.collateral: {
          switch (token.protocolType) {
            case ProtocolType.Ethereum: {
              const provider = multiProtocolProvider.getEthersV5Provider(chain);
              const tokenContract = ERC20__factory.connect(
                token.address,
                provider,
              );
              const collateralBalance = await tokenContract.balanceOf(
                token.hypCollateralAddress,
              );

              return parseFloat(
                ethers.utils.formatUnits(collateralBalance, token.decimals),
              );
            }
            case ProtocolType.Sealevel: {
              const adapter = new SealevelHypCollateralAdapter(
                chain,
                multiProtocolProvider,
                {
                  token: token.address,
                  warpRouter: token.hypCollateralAddress,
                  // Mailbox only required for transfers, using system as placeholder
                  mailbox: SystemProgram.programId.toBase58(),
                },
                token.isSpl2022,
              );
              const collateralBalance = ethers.BigNumber.from(
                await adapter.getBalance(token.hypCollateralAddress),
              );
              return parseFloat(
                ethers.utils.formatUnits(collateralBalance, token.decimals),
              );
            }
            case ProtocolType.Cosmos: {
              const adapter = new CwNativeTokenAdapter(
                chain,
                multiProtocolProvider,
                {
                  token: token.address,
                },
                token.address,
              );
              const collateralBalance = ethers.BigNumber.from(
                await adapter.getBalance(token.hypCollateralAddress),
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
                token.hypSyntheticAddress,
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
    },
  );

  return await promiseObjAll(output);
}

function updateTokenBalanceMetrics(
  tokenConfig: WarpTokenConfig,
  balances: ChainMap<number>,
) {
  objMap(tokenConfig, (chain: ChainName, token: WarpTokenConfig[ChainName]) => {
    const tokenAddress =
      token.type === TokenType.native
        ? ethers.constants.AddressZero
        : token.type === TokenType.collateral
        ? token.address
        : token.hypSyntheticAddress;
    const walletAddress =
      token.type === TokenType.native
        ? token.hypNativeAddress
        : token.type === TokenType.collateral
        ? token.hypCollateralAddress
        : token.hypSyntheticAddress;

    warpRouteTokenBalance
      .labels({
        chain_name: chain,
        token_address: tokenAddress,
        token_name: token.name,
        wallet_address: walletAddress,
        token_type: token.type,
      })
      .set(balances[chain]);
    debug('Wallet balance updated for chain', {
      chain,
      token: token.name,
      balance: balances[chain],
    });
  });
}

main().then(console.log).catch(console.error);
