import { Connection } from '@solana/web3.js';
import { ethers } from 'ethers';
import { Gauge, Registry } from 'prom-client';

import {
  ERC20__factory,
  SealevelHypCollateralAdapter,
} from '@hyperlane-xyz/hyperlane-token';
import { ChainMap, MultiProvider } from '@hyperlane-xyz/sdk';
import { debug, objMap, promiseObjAll } from '@hyperlane-xyz/utils';

import { startMetricsServer } from '../../src/utils/metrics';
import { getEnvironmentConfig } from '../utils';

import { chains } from './chain_config';
import { WarpTokenConfig, tokenList } from './token_config';

const metricsRegister = new Registry();
const warpRouteTokenBalance = new Gauge({
  name: 'warp_route_token_balance',
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
  startMetricsServer(metricsRegister);

  const checkFreqeuncy = 1000;

  const config = getEnvironmentConfig('mainnet2');
  const mainnetMultiProvider = await config.getMultiProvider();

  const multiProvider = new MultiProvider(chains);
  multiProvider.addChain(mainnetMultiProvider.getChainMetadata('bsc'));
  multiProvider.intersect(['bsc', 'nautilus', 'solana']);

  setInterval(async () => {
    console.log('Checking balances');
    const balances = await checkBalance(tokenList, multiProvider);
    await updateTokenBalanceMetrics(tokenList, balances);
  }, checkFreqeuncy);
  return true;
}

async function checkBalance(
  tokenConfig: WarpTokenConfig,
  multiprovider: MultiProvider,
): Promise<ChainMap<number>> {
  const output: ChainMap<Promise<number>> = objMap(
    tokenConfig,
    async (chain, token) => {
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

async function updateTokenBalanceMetrics(
  tokenConfig: WarpTokenConfig,
  balances: ChainMap<number>,
) {
  objMap(tokenConfig, (chain, token) => {
    if (token.type === 'native') {
      warpRouteTokenBalance
        .labels({
          chain_name: chain,
          token_address: ethers.constants.AddressZero,
          token_name: token.name,
          wallet_address: token.hypNativeAddress,
          token_type: token.type,
        })
        .set(balances[chain]);
    } else {
      warpRouteTokenBalance
        .labels({
          chain_name: chain,
          token_address: token.address,
          token_name: token.name,
          wallet_address: token.hypCollateralAddress,
          token_type: token.type,
        })
        .set(balances[chain]);
    }
    debug('Wallet balance updated for chain', {
      chain,
      token: token.name,
      balance: balances[chain],
    });
  });
}

main().then(console.log).catch(console.error);
