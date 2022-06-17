import { StaticCeloProvider } from '@celo-tools/celo-ethers-wrapper';
import { ethers } from 'ethers';

import { IChainConnection } from './provider';
import { ChainMap, ChainName } from './types';

export const ethereum: IChainConnection = {
  provider: new ethers.providers.JsonRpcProvider(
    'https://mainnet-nethermind.blockscout.com',
    1,
  ),
  confirmations: 7,
  blockExplorerUrl: 'https://etherscan.io',
};

export const celo: IChainConnection = {
  provider: new StaticCeloProvider('https://forno.celo.org', 42220),
  confirmations: 1,
  blockExplorerUrl: 'https://celoscan.xyz',
};

export const polygon: IChainConnection = {
  provider: new ethers.providers.JsonRpcProvider(
    'https://rpc-mainnet.matic.quiknode.pro',
    137,
  ),
  confirmations: 200,
  blockExplorerUrl: 'https://polygonscan.com',
};

export const avalanche: IChainConnection = {
  provider: new ethers.providers.JsonRpcProvider(
    'https://api.avax.network/ext/bc/C/rpc',
    43114,
  ),
  confirmations: 1,
  blockExplorerUrl: 'https://snowtrace.io',
};

export const arbitrum: IChainConnection = {
  provider: new ethers.providers.JsonRpcProvider(
    'https://arb1.arbitrum.io/rpc',
    42161,
  ),
  confirmations: 1,
  blockExplorerUrl: 'https://arbiscan.io/',
};

export const optimism: IChainConnection = {
  provider: new ethers.providers.JsonRpcProvider(
    'https://mainnet.optimism.io',
    10,
  ),
  confirmations: 1,
  blockExplorerUrl: 'https://optimistic.etherscan.io/',
};

export const bsc: IChainConnection = {
  provider: new ethers.providers.JsonRpcProvider(
    'https://rpc.ankr.com/bsc',
    56,
  ),
  confirmations: 1,
  blockExplorerUrl: 'https://bscscan.com/',
};

export const alfajores: IChainConnection = {
  provider: new StaticCeloProvider('https://alfajores-forno.celo.org', 44787),
  confirmations: 1,
};

export const auroratestnet: IChainConnection = {
  provider: new ethers.providers.JsonRpcProvider(
    'https://testnet.aurora.dev',
    1313161555,
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

export const goerli: IChainConnection = {
  provider: new ethers.providers.JsonRpcProvider(
    'https://rpc.ankr.com/eth_goerli',
    5,
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
  arbitrum,
  auroratestnet,
  bsc,
  ethereum,
  celo,
  polygon,
  avalanche,
  alfajores,
  fuji,
  goerli,
  kovan,
  mumbai,
  bsctestnet,
  arbitrumrinkeby,
  optimism,
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

export const chainConnectionConfigs: ChainMap<ChainName, IChainConnection> =
  _configs;
