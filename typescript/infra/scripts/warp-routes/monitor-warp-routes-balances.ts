import { Connection } from '@solana/web3.js';
import { ethers } from 'ethers';
import { Gauge, Registry } from 'prom-client';
import yargs from 'yargs';

import {
  ERC20__factory,
  SealevelHypCollateralAdapter,
} from '@hyperlane-xyz/hyperlane-token';
import { ChainMap, ChainName, MultiProvider } from '@hyperlane-xyz/sdk';
import { debug, objMap, promiseObjAll } from '@hyperlane-xyz/utils';

import {
  WarpTokenConfig,
  tokenList,
} from '../../src/config/nautilus_token_config';
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
  const { checkFrequency } = await yargs(process.argv.slice(2))
    .describe('checkFrequency', 'frequency to check balances in ms')
    .demandOption('checkFrequency')
    .alias('c', 'checkFrequency')
    .number('checkFrequency')
    .parse();
  console.log('checkFrequency', checkFrequency);

  startMetricsServer(metricsRegister);

  const multiProvider = new MultiProvider();

  setInterval(async () => {
    try {
      console.log('Checking balances');
      const balances = await checkBalance(tokenList, multiProvider);
      updateTokenBalanceMetrics(tokenList, balances);
    } catch (e) {
      console.error('Error checking balances', e);
    }
  }, checkFrequency);
  return true;
}

async function checkBalance(
  tokenConfig: WarpTokenConfig,
  multiprovider: MultiProvider,
): Promise<ChainMap<number>> {
  const output: ChainMap<Promise<number>> = objMap(
    tokenConfig,
    async (chain: ChainName, token: WarpTokenConfig[ChainName]) => {
      const provider = multiprovider.getProvider(chain);
      if (token.type === 'native') {
        if (token.protocolType === 'ethereum') {
          const nativeBalance = await provider.getBalance(
            token.hypNativeAddress,
          );
          return parseFloat(
            ethers.utils.formatUnits(nativeBalance, token.decimals),
          );
        } else {
          // TODO - solana native
          return 0;
        }
      } else {
        if (token.protocolType === 'ethereum') {
          const tokenContract = ERC20__factory.connect(token.address, provider);
          const collateralBalance = await tokenContract.balanceOf(
            token.hypCollateralAddress,
          );

          return parseFloat(
            ethers.utils.formatUnits(collateralBalance, token.decimals),
          );
        } else {
          const connection = new Connection(multiprovider.getRpcUrl(chain));
          const adapter = new SealevelHypCollateralAdapter(
            connection,
            token.hypCollateralAddress,
            token.address,
            token.isSpl2022,
          );
          const collateralBalance = ethers.BigNumber.from(
            await adapter.getBalance(token.hypCollateralAddress),
          );
          return parseFloat(
            ethers.utils.formatUnits(collateralBalance, token.decimals),
          );
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
      token.type === 'native' ? ethers.constants.AddressZero : token.address;
    const walletAddress =
      token.type === 'native'
        ? token.hypNativeAddress
        : token.hypCollateralAddress;

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
