import { StaticCeloJsonRpcProvider } from 'celo-ethers-provider';
import { ethers } from 'ethers';

import { IChainConnection } from './provider';
import { ChainMap, ChainName } from './types';

export const ethereum: IChainConnection = {
  provider: new ethers.providers.JsonRpcProvider(
    'https://mainnet-nethermind.blockscout.com',
    1,
  ),
  confirmations: 7,
};

export const celo: IChainConnection = {
  provider: new StaticCeloJsonRpcProvider('https://forno.celo.org', 42220),
  confirmations: 1,
};

export const polygon: IChainConnection = {
  provider: new ethers.providers.JsonRpcProvider(
    'https://rpc-mainnet.matic.quiknode.pro',
    137,
  ),
  confirmations: 200,
};

export const avalanche: IChainConnection = {
  provider: new ethers.providers.JsonRpcProvider(
    'https://api.avax.network/ext/bc/C/rpc',
    43114,
  ),
  confirmations: 1,
};

export const alfajores: IChainConnection = {
  provider: new StaticCeloJsonRpcProvider(
    'https://alfajores-forno.celo.org',
    44787,
  ),
  confirmations: 1,
};

export const fuji: IChainConnection = {
  provider: new ethers.providers.JsonRpcProvider(
    'https://api.avax-test.network/ext/bc/C/rpc',
    43113,
  ),
  confirmations: 1,
};

export const kovan: IChainConnection = {
  provider: new ethers.providers.JsonRpcProvider(
    'https://kovan.poa.network',
    42,
  ),
  confirmations: 1,
};

export const mumbai: IChainConnection = {
  provider: new ethers.providers.JsonRpcProvider(
    'https://rpc-mumbai.maticvigil.com',
    80001,
  ),
  confirmations: 30,
};

export const bsctestnet: IChainConnection = {
  provider: new ethers.providers.JsonRpcProvider(
    'https://data-seed-prebsc-1-s3.binance.org:8545',
    97,
  ),
  confirmations: 1,
};

export const arbitrumrinkeby: IChainConnection = {
  provider: new ethers.providers.JsonRpcProvider(
    'https://rinkeby.arbitrum.io/rpc',
    421611,
  ),
  confirmations: 1,
};

export const optimismkovan: IChainConnection = {
  provider: new ethers.providers.JsonRpcProvider(
    'https://kovan.optimism.io',
    69,
  ),
  confirmations: 1,
};

export const test1: IChainConnection = {
  provider: new ethers.providers.JsonRpcProvider(
    'http://localhost:8545',
    31337,
  ),
  confirmations: 1,
};

export const test2: IChainConnection = {
  provider: new ethers.providers.JsonRpcProvider(
    'http://localhost:8545',
    31337,
  ),
  confirmations: 1,
};

export const test3: IChainConnection = {
  provider: new ethers.providers.JsonRpcProvider(
    'http://localhost:8545',
    31337,
  ),
  confirmations: 1,
};

const _configs = {
  ethereum,
  celo,
  polygon,
  avalanche,
  alfajores,
  fuji,
  kovan,
  mumbai,
  bsctestnet,
  arbitrumrinkeby,
  optimismkovan,
  test1,
  test2,
  test3,
};

export const addSignerToConnection =
  <Chain extends ChainName>(signer: ethers.Signer) =>
  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
  (_chain: Chain, connection: IChainConnection) => ({
    ...connection,
    signer,
  });

export const chainConnectionConfigs: ChainMap<
  keyof typeof _configs,
  IChainConnection
> = _configs;
