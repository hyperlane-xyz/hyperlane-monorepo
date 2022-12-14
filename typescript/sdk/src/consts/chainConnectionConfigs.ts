import { ethers } from 'ethers';

import { StaticCeloJsonRpcProvider } from '@hyperlane-xyz/celo-ethers-provider';

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
  blockExplorerUrl: 'https://alfajores.celoscan.io',
  apiPrefix: 'api-',
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
  apiPrefix: 'api-',
};

export const goerli: IChainConnection = {
  provider: new ethers.providers.JsonRpcProvider(
    'https://eth-goerli.public.blastapi.io',
    5,
  ),
  confirmations: 1,
  blockExplorerUrl: 'https://goerli.etherscan.io/',
  apiPrefix: 'api-',
};

export const optimismgoerli: IChainConnection = {
  provider: new ethers.providers.JsonRpcProvider(
    'https://goerli.optimism.io',
    420,
  ),
  confirmations: 1,
  blockExplorerUrl: 'https://goerli-optimism.etherscan.io/',
  apiPrefix: 'api-',
};

export const arbitrumgoerli: IChainConnection = {
  provider: new ethers.providers.JsonRpcProvider(
    'https://goerli-rollup.arbitrum.io/rpc	',
    421613,
  ),
  confirmations: 1,
  blockExplorerUrl: 'https://goerli.arbiscan.io',
  apiPrefix: 'api-',
};

export const zksync2testnet: IChainConnection = {
  provider: new ethers.providers.JsonRpcProvider(
    'https://zksync2-testnet.zksync.dev',
    280,
  ),
  confirmations: 1,
  blockExplorerUrl: 'https://zksync2-testnet.zkscan.io/',
  apiPrefix: 'api-',
};

export const mumbai: IChainConnection = {
  provider: new ethers.providers.JsonRpcProvider(
    'https://rpc-mumbai.maticvigil.com',
    80001,
  ),
  confirmations: 30,
  blockExplorerUrl: 'https://mumbai.polygonscan.com',
  apiPrefix: 'api-',
};

export const bsctestnet: IChainConnection = {
  provider: new ethers.providers.JsonRpcProvider(
    'https://data-seed-prebsc-1-s3.binance.org:8545',
    97,
  ),
  confirmations: 1,
  blockExplorerUrl: 'https://testnet.bscscan.com',
  apiPrefix: 'api-',
};

export const moonbasealpha: IChainConnection = {
  provider: new ethers.providers.JsonRpcProvider(
    'https://rpc.api.moonbase.moonbeam.network',
    1287,
  ),
  confirmations: 1,
  blockExplorerUrl: 'https://moonbase.moonscan.io/',
  apiPrefix: 'api-',
};

export const moonbeam: IChainConnection = {
  provider: new ethers.providers.JsonRpcProvider(
    'https://rpc.api.moonbeam.network	',
    1284,
  ),
  confirmations: 1,
  blockExplorerUrl: 'https://moonscan.io/',
  apiPrefix: 'api-moonbeam.',
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
  mumbai,
  bsctestnet,
  optimism,
  moonbasealpha,
  moonbeam,
  optimismgoerli,
  arbitrumgoerli,
  zksync2testnet,
  test1,
  test2,
  test3,
};

export const testChainConnectionConfigs = {
  test1,
  test2,
  test3,
};
