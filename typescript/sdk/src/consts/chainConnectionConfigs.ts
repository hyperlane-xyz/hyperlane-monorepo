import { ethers } from 'ethers';

import { StaticCeloJsonRpcProvider } from '@abacus-network/celo-ethers-provider';

import { ChainMap, ChainName, IChainConnection } from '../types';

export const ethereum: IChainConnection = {
  provider: new ethers.providers.JsonRpcProvider(
    'https://cloudflare-eth.com',
    1,
  ),
  confirmations: 7,
  blockExplorerUrl: 'https://etherscan.io',
};

export const celo: IChainConnection = {
  provider: new StaticCeloJsonRpcProvider('https://forno.celo.org', 42220),
  confirmations: 1,
  blockExplorerUrl: 'https://celoscan.io',
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
  confirmations: 3,
  blockExplorerUrl: 'https://snowtrace.io',
};

export const arbitrum: IChainConnection = {
  provider: new ethers.providers.JsonRpcProvider(
    'https://arb1.arbitrum.io/rpc',
    42161,
  ),
  confirmations: 1,
  blockExplorerUrl: 'https://arbiscan.io',
};

export const optimism: IChainConnection = {
  provider: new ethers.providers.JsonRpcProvider(
    'https://mainnet.optimism.io',
    10,
  ),
  confirmations: 1,
  blockExplorerUrl: 'https://optimistic.etherscan.io',
  apiPrefix: 'api-',
};

export const bsc: IChainConnection = {
  provider: new ethers.providers.JsonRpcProvider(
    'https://rpc.ankr.com/bsc',
    56,
  ),
  confirmations: 1,
  blockExplorerUrl: 'https://bscscan.com',
};

export const alfajores: IChainConnection = {
  provider: new StaticCeloJsonRpcProvider(
    'https://alfajores-forno.celo-testnet.org',
    44787,
  ),
  confirmations: 1,
  blockExplorerUrl: 'https://alfajores-blockscout.celo-testnet.org',
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
  confirmations: 3,
  blockExplorerUrl: 'https://testnet.snowtrace.io',
};

export const goerli: IChainConnection = {
  provider: new ethers.providers.JsonRpcProvider(
    'https://rpc.ankr.com/eth_goerli',
    5,
  ),
  confirmations: 1,
  blockExplorerUrl: 'https://goerli.etherscan.io/',
};

export const kovan: IChainConnection = {
  provider: new ethers.providers.JsonRpcProvider(
    'https://kovan.infura.io/v3/9aa3d95b3bc440fa88ea12eaa4456161',
    42,
  ),
  confirmations: 1,
  blockExplorerUrl: 'https://kovan.etherscan.io',
};

export const mumbai: IChainConnection = {
  provider: new ethers.providers.JsonRpcProvider(
    'https://rpc-mumbai.maticvigil.com',
    80001,
  ),
  confirmations: 30,
  blockExplorerUrl: 'https://mumbai.polygonscan.com',
};

export const bsctestnet: IChainConnection = {
  provider: new ethers.providers.JsonRpcProvider(
    'https://data-seed-prebsc-1-s3.binance.org:8545',
    97,
  ),
  confirmations: 1,
  blockExplorerUrl: 'https://testnet.bscscan.com',
};

export const arbitrumrinkeby: IChainConnection = {
  provider: new ethers.providers.JsonRpcProvider(
    'https://rinkeby.arbitrum.io/rpc',
    421611,
  ),
  confirmations: 1,
  blockExplorerUrl: 'https://testnet.arbiscan.io',
};

export const optimismkovan: IChainConnection = {
  provider: new ethers.providers.JsonRpcProvider(
    'https://kovan.optimism.io',
    69,
  ),
  confirmations: 1,
  blockExplorerUrl: 'https://kovan-optimistic.etherscan.io',
};

export const moonbasealpha: IChainConnection = {
  provider: new ethers.providers.JsonRpcProvider(
    'https://rpc.api.moonbase.moonbeam.network',
    1287,
  ),
  confirmations: 1,
  blockExplorerUrl: 'https://moonbase.moonscan.io/',
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

export const chainConnectionConfigs: ChainMap<ChainName, IChainConnection> = {
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
  moonbasealpha,
  test1,
  test2,
  test3,
};

export const testChainConnectionConfigs = {
  test1,
  test2,
  test3,
};
