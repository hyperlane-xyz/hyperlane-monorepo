import { StaticCeloJsonRpcProvider } from 'celo-ethers-provider';
import { ethers } from 'ethers';

import { IDomainConnection } from './provider';
import { ChainMap, ChainName } from './types';

export const alfajores: IDomainConnection = {
  provider: new StaticCeloJsonRpcProvider(
    'https://alfajores-forno.celo.org',
    44787,
  ),
  confirmations: 1,
};

export const fuji: IDomainConnection = {
  provider: new ethers.providers.JsonRpcProvider(
    'https://api.avax-test.network/ext/bc/C/rpc',
    43113,
  ),
  confirmations: 1,
};

export const kovan: IDomainConnection = {
  provider: new ethers.providers.JsonRpcProvider(
    'https://kovan.poa.network',
    42,
  ),
  confirmations: 1,
};

export const mumbai: IDomainConnection = {
  provider: new ethers.providers.JsonRpcProvider(
    'https://rpc-mumbai.maticvigil.com',
    80001,
  ),
  confirmations: 30,
};

export const bsctestnet: IDomainConnection = {
  provider: new ethers.providers.JsonRpcProvider(
    'https://data-seed-prebsc-1-s3.binance.org:8545',
    97,
  ),
  confirmations: 1,
};

export const arbitrumrinkeby: IDomainConnection = {
  provider: new ethers.providers.JsonRpcProvider(
    'https://rinkeby.arbitrum.io/rpc',
    421611,
  ),
  confirmations: 1,
};

export const optimismkovan: IDomainConnection = {
  provider: new ethers.providers.JsonRpcProvider(
    'https://kovan.optimism.io',
    69,
  ),
  confirmations: 1,
};

export const test1: IDomainConnection = {
  provider: new ethers.providers.JsonRpcProvider(
    'http://localhost:8545',
    31337,
  ),
  confirmations: 1,
};

export const test2: IDomainConnection = {
  provider: new ethers.providers.JsonRpcProvider(
    'http://localhost:8545',
    31337,
  ),
  confirmations: 1,
};

export const test3: IDomainConnection = {
  provider: new ethers.providers.JsonRpcProvider(
    'http://localhost:8545',
    31337,
  ),
  confirmations: 1,
};

const _configs = {
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
  <Networks extends ChainName>(signer: ethers.Signer) =>
  (_chain: Networks, connection: IDomainConnection) => ({
    ...connection,
    signer,
  });

export const chainConnectionConfigs: ChainMap<
  keyof typeof _configs,
  IDomainConnection
> = _configs;
