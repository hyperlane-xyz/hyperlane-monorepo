import type { Chain as WagmiChain } from '@wagmi/chains';

import { objMap } from '../utils/objects';

import { ChainName, Chains, Mainnets, Testnets } from './chains';

export enum ExplorerFamily {
  Etherscan = 'etherscan',
  Blockscout = 'blockscout',
  Other = 'other',
}

/**
 * Collection of useful properties and settings
 * for Hyperlane-supported chains
 */
export interface ChainMetadata {
  id: number;
  name: ChainName;
  /** Human-readable name */
  displayName: string;
  /** Shorter human-readable name */
  displayNameShort?: string;
  /** Default currency/token used by chain */
  nativeToken: {
    name: string;
    symbol: string;
    decimals: number;
  };
  /** Collection of RPC endpoints */
  publicRpcUrls: Array<{
    http: string;
    webSocket?: string;
    pagination?: RpcPagination;
  }>;
  /** Collection of block explorers */
  blockExplorers: Array<{
    name: string;
    url: string;
    family: ExplorerFamily;
    apiUrl?: string;
  }>;
  blocks: {
    // Number of blocks to wait before considering a transaction confirmed
    confirmations: number;
    // TODO consider merging with confirmations, require agent code changes
    // Number of blocks before a transaction has a near-zero chance of reverting
    reorgPeriod: number;
    // Rough estimate of time per block in seconds
    estimateBlockTime: number;
  };
  // The CoinGecko API sometimes expects IDs that do not match ChainNames
  gasCurrencyCoinGeckoId?: string;
  // URL of the gnosis safe transaction service.
  gnosisSafeTransactionServiceUrl?: string;
}

export interface RpcPagination {
  blocks: number;
  from: number;
}

/**
 * Common native currencies
 */
const avaxToken = {
  decimals: 18,
  name: 'Avalanche',
  symbol: 'AVAX',
};
const bnbToken = {
  decimals: 18,
  name: 'BNB',
  symbol: 'BNB',
};
const celoToken = {
  decimals: 18,
  name: 'CELO',
  symbol: 'CELO',
};
const etherToken = { name: 'Ether', symbol: 'ETH', decimals: 18 };
const maticToken = { name: 'MATIC', symbol: 'MATIC', decimals: 18 };

/**
 * Chain metadata
 */

export const alfajores: ChainMetadata = {
  id: 44787,
  name: Chains.alfajores,
  displayName: 'Alfajores',
  nativeToken: celoToken,
  publicRpcUrls: [{ http: 'https://alfajores-forno.celo-testnet.org' }],
  blockExplorers: [
    {
      name: 'CeloScan',
      url: 'https://alfajores.celoscan.io',
      family: ExplorerFamily.Etherscan,
    },
    {
      name: 'Blockscout',
      url: 'https://explorer.celo.org/alfajores',
      family: ExplorerFamily.Blockscout,
    },
  ],
  blocks: {
    confirmations: 1,
    reorgPeriod: 0,
    estimateBlockTime: 5,
  },
};

export const arbitrum: ChainMetadata = {
  id: 42161,
  name: Chains.arbitrum,
  displayName: 'Arbitrum',
  nativeToken: etherToken,
  publicRpcUrls: [{ http: 'https://arb1.arbitrum.io/rpc' }],
  blockExplorers: [
    {
      name: 'Arbiscan',
      url: 'https://arbiscan.io',
      apiUrl: 'https://api.arbiscan.io',
      family: ExplorerFamily.Etherscan,
    },
  ],
  blocks: {
    confirmations: 1,
    reorgPeriod: 0,
    estimateBlockTime: 3,
  },
  gasCurrencyCoinGeckoId: 'ethereum', // ETH is used for gas
  gnosisSafeTransactionServiceUrl:
    'https://safe-transaction.arbitrum.gnosis.io/',
};

export const arbitrumgoerli: ChainMetadata = {
  id: 421613,
  name: Chains.arbitrumgoerli,
  displayName: 'Arbitrum Goerli',
  displayNameShort: 'Arb. Goerli',
  nativeToken: etherToken,
  publicRpcUrls: [{ http: 'https://goerli-rollup.arbitrum.io/rpc' }],
  blockExplorers: [
    {
      name: 'Arbiscan',
      url: 'https://goerli.arbiscan.io/',
      apiUrl: 'https://api-goerli.arbiscan.io',
      family: ExplorerFamily.Etherscan,
    },
  ],
  blocks: {
    confirmations: 1,
    reorgPeriod: 1,
    estimateBlockTime: 3,
  },
};

export const avalanche: ChainMetadata = {
  id: 43114,
  name: Chains.avalanche,
  displayName: 'Avalanche',
  nativeToken: avaxToken,
  publicRpcUrls: [
    {
      http: 'https://api.avax.network/ext/bc/C/rpc',
      pagination: {
        blocks: 100000,
        from: 6765067,
      },
    },
  ],
  blockExplorers: [
    {
      name: 'SnowTrace',
      url: 'https://snowtrace.io',
      apiUrl: 'https://api.snowtrace.io',
      family: ExplorerFamily.Other,
    },
  ],
  blocks: {
    confirmations: 3,
    reorgPeriod: 3,
    estimateBlockTime: 2,
  },
  gasCurrencyCoinGeckoId: 'avalanche-2',
  gnosisSafeTransactionServiceUrl:
    'https://safe-transaction.avalanche.gnosis.io/',
};

export const bsc: ChainMetadata = {
  id: 56,
  name: Chains.bsc,
  displayName: 'Binance Smart Chain',
  displayNameShort: 'Binance',
  nativeToken: bnbToken,
  publicRpcUrls: [
    { http: 'https://bsc-dataseed.binance.org' },
    { http: 'https://rpc.ankr.com/bsc' },
  ],
  blockExplorers: [
    {
      name: 'BscScan',
      url: 'https://bscscan.com',
      apiUrl: 'https://api.bscscan.com',
      family: ExplorerFamily.Etherscan,
    },
  ],
  blocks: {
    confirmations: 1,
    reorgPeriod: 15,
    estimateBlockTime: 3,
  },
  gasCurrencyCoinGeckoId: 'binancecoin',
  gnosisSafeTransactionServiceUrl: 'https://safe-transaction.bsc.gnosis.io/',
};

export const bsctestnet: ChainMetadata = {
  id: 97,
  name: Chains.bsctestnet,
  displayName: 'BSC Testnet',
  nativeToken: bnbToken,
  publicRpcUrls: [{ http: 'https://data-seed-prebsc-1-s3.binance.org:8545' }],
  blockExplorers: [
    {
      name: 'BscScan',
      url: 'https://testnet.bscscan.com',
      apiUrl: 'https://api-testnet.bscscan.com',
      family: ExplorerFamily.Etherscan,
    },
  ],
  blocks: {
    confirmations: 1,
    reorgPeriod: 9,
    estimateBlockTime: 3,
  },
};

export const celo: ChainMetadata = {
  id: 42220,
  name: Chains.celo,
  displayName: 'Celo',
  nativeToken: celoToken,
  publicRpcUrls: [{ http: 'https://forno.celo.org' }],
  blockExplorers: [
    {
      name: 'CeloScan',
      url: 'https://celoscan.io',
      apiUrl: 'https://api.celoscan.io',
      family: ExplorerFamily.Etherscan,
    },
    {
      name: 'Blockscout',
      url: 'https://explorer.celo.org',
      family: ExplorerFamily.Blockscout,
    },
  ],
  blocks: {
    confirmations: 1,
    reorgPeriod: 0,
    estimateBlockTime: 5,
  },
  gnosisSafeTransactionServiceUrl:
    'https://transaction-service.gnosis-safe-staging.celo-networks-dev.org',
};

export const ethereum: ChainMetadata = {
  id: 1,
  name: Chains.ethereum,
  displayName: 'Ethereum',
  nativeToken: etherToken,
  publicRpcUrls: [{ http: 'https://cloudflare-eth.com' }],
  blockExplorers: [
    {
      name: 'Etherscan',
      url: 'https://etherscan.io',
      apiUrl: 'https://api.etherscan.io',
      family: ExplorerFamily.Etherscan,
    },
    {
      name: 'Blockscout',
      url: 'https://blockscout.com/eth/mainnet',
      family: ExplorerFamily.Blockscout,
    },
  ],
  blocks: {
    confirmations: 7,
    reorgPeriod: 20,
    estimateBlockTime: 13,
  },
  gnosisSafeTransactionServiceUrl: 'https://safe-transaction.gnosis.io',
};

export const fuji: ChainMetadata = {
  id: 43113,
  name: Chains.fuji,
  displayName: 'Fuji',
  nativeToken: avaxToken,
  publicRpcUrls: [{ http: 'https://api.avax-test.network/ext/bc/C/rpc' }],
  blockExplorers: [
    {
      name: 'SnowTrace',
      url: 'https://testnet.snowtrace.io',
      apiUrl: 'https://api-testnet.snowtrace.io',
      family: ExplorerFamily.Other,
    },
  ],
  blocks: {
    confirmations: 3,
    reorgPeriod: 3,
    estimateBlockTime: 2,
  },
};

export const goerli: ChainMetadata = {
  id: 5,
  name: Chains.goerli,
  displayName: 'Goerli',
  nativeToken: etherToken,
  publicRpcUrls: [{ http: 'https://rpc.ankr.com/eth_goerli' }],
  blockExplorers: [
    {
      name: 'Etherscan',
      url: 'https://goerli.etherscan.io',
      apiUrl: 'https://api-goerli.etherscan.io',
      family: ExplorerFamily.Etherscan,
    },
  ],
  blocks: {
    confirmations: 1,
    reorgPeriod: 2,
    estimateBlockTime: 13,
  },
};

export const moonbasealpha: ChainMetadata = {
  id: 1287,
  name: Chains.moonbasealpha,
  displayName: 'Moonbase Alpha',
  displayNameShort: 'Moonbase',
  nativeToken: {
    decimals: 18,
    name: 'DEV',
    symbol: 'DEV',
  },
  publicRpcUrls: [{ http: 'https://rpc.api.moonbase.moonbeam.network' }],
  blockExplorers: [
    {
      name: 'MoonScan',
      url: 'https://moonbase.moonscan.io',
      apiUrl: 'https://api-moonbase.moonscan.io',
      family: ExplorerFamily.Etherscan,
    },
  ],
  blocks: {
    confirmations: 1,
    reorgPeriod: 1,
    estimateBlockTime: 12,
  },
};

export const moonbeam: ChainMetadata = {
  id: 1284,
  name: Chains.moonbeam,
  displayName: 'Moonbeam',
  nativeToken: {
    decimals: 18,
    name: 'GLMR',
    symbol: 'GLMR',
  },
  publicRpcUrls: [{ http: 'https://rpc.api.moonbeam.network' }],
  blockExplorers: [
    {
      name: 'MoonScan',
      url: 'https://moonscan.io',
      apiUrl: 'https://api-moonbeam.moonscan.io',
      family: ExplorerFamily.Etherscan,
    },
  ],
  blocks: {
    confirmations: 1,
    reorgPeriod: 1,
    estimateBlockTime: 12,
  },
};

export const mumbai: ChainMetadata = {
  id: 80001,
  name: Chains.mumbai,
  displayName: 'Mumbai',
  nativeToken: maticToken,
  publicRpcUrls: [
    {
      http: 'https://rpc-mumbai.maticvigil.com',
      pagination: {
        // eth_getLogs and eth_newFilter are limited to a 10,000 blocks range
        blocks: 10000,
        from: 22900000,
      },
    },
    {
      http: 'https://matic-mumbai.chainstacklabs.com',
    },
  ],
  blockExplorers: [
    {
      name: 'PolygonScan',
      url: 'https://mumbai.polygonscan.com',
      apiUrl: 'https://api-testnet.polygonscan.com',
      family: ExplorerFamily.Etherscan,
    },
  ],
  blocks: {
    confirmations: 3,
    reorgPeriod: 32,
    estimateBlockTime: 5,
  },
};

export const optimism: ChainMetadata = {
  id: 10,
  name: Chains.optimism,
  displayName: 'Optimism',
  nativeToken: etherToken,
  publicRpcUrls: [{ http: 'https://mainnet.optimism.io' }],
  blockExplorers: [
    {
      name: 'Etherscan',
      url: 'https://optimistic.etherscan.io',
      apiUrl: 'https://api-optimistic.etherscan.io',
      family: ExplorerFamily.Etherscan,
    },
  ],
  blocks: {
    confirmations: 1,
    reorgPeriod: 0,
    estimateBlockTime: 3,
  },
  gasCurrencyCoinGeckoId: 'ethereum', // ETH is used for gas
  gnosisSafeTransactionServiceUrl:
    'https://safe-transaction.optimism.gnosis.io/',
};

export const optimismgoerli: ChainMetadata = {
  id: 420,
  name: Chains.optimismgoerli,
  displayName: 'Optimism Goerli',
  displayNameShort: 'Opt. Goerli',
  nativeToken: etherToken,
  publicRpcUrls: [{ http: 'https://goerli.optimism.io' }],
  blockExplorers: [
    {
      name: 'Etherscan',
      url: 'https://goerli-optimism.etherscan.io',
      apiUrl: 'https://api-goerli-optimism.etherscan.io',
      family: ExplorerFamily.Etherscan,
    },
  ],
  blocks: {
    confirmations: 1,
    reorgPeriod: 1,
    estimateBlockTime: 3,
  },
};

export const polygon: ChainMetadata = {
  id: 137,
  name: Chains.polygon,
  displayName: 'Polygon',
  nativeToken: etherToken,
  publicRpcUrls: [
    {
      http: 'https://rpc-mainnet.matic.quiknode.pro',
      pagination: {
        // Needs to be low to avoid RPC timeouts
        blocks: 10000,
        from: 19657100,
      },
    },
    { http: 'https://polygon-rpc.com' },
  ],
  blockExplorers: [
    {
      name: 'PolygonScan',
      url: 'https://polygonscan.com',
      apiUrl: 'https://api.polygonscan.com',
      family: ExplorerFamily.Etherscan,
    },
  ],
  blocks: {
    confirmations: 200,
    reorgPeriod: 256,
    estimateBlockTime: 2,
  },
  gasCurrencyCoinGeckoId: 'matic-network',
  gnosisSafeTransactionServiceUrl:
    'https://safe-transaction.polygon.gnosis.io/',
};

export const test1: ChainMetadata = {
  id: 13371,
  name: Chains.test1,
  displayName: 'Test 1',
  nativeToken: etherToken,
  publicRpcUrls: [{ http: 'http://localhost:8545' }],
  blockExplorers: [],
  blocks: {
    confirmations: 1,
    reorgPeriod: 0,
    estimateBlockTime: 3,
  },
};

export const test2: ChainMetadata = {
  id: 13372,
  name: Chains.test2,
  displayName: 'Test 2',
  nativeToken: etherToken,
  publicRpcUrls: [{ http: 'http://localhost:8545' }],
  blockExplorers: [],
  blocks: {
    confirmations: 1,
    reorgPeriod: 1,
    estimateBlockTime: 3,
  },
};

export const test3: ChainMetadata = {
  id: 13373,
  name: Chains.test3,
  displayName: 'Test 3',
  nativeToken: etherToken,
  publicRpcUrls: [{ http: 'http://localhost:8545' }],
  blockExplorers: [],
  blocks: {
    confirmations: 1,
    reorgPeriod: 2,
    estimateBlockTime: 3,
  },
};

/**
 * Collection maps
 *
 * NOTE: When adding chains here, consider also adding the
 * corresponding chain logo images in the /sdk/logos/* folders
 */
export const chainMetadata = {
  alfajores,
  arbitrum,
  arbitrumgoerli,
  avalanche,
  bsc,
  bsctestnet,
  celo,
  ethereum,
  fuji,
  goerli,
  moonbasealpha,
  moonbeam,
  mumbai,
  optimism,
  optimismgoerli,
  polygon,
  test1,
  test2,
  test3,
} as Record<ChainName, ChainMetadata>;

// For convenient use in wagmi-based apps
export const wagmiChainMetadata: Record<ChainName, WagmiChain> = objMap(
  chainMetadata,
  (_, metadata) => ({
    id: metadata.id,
    name: metadata.displayName,
    network: metadata.name as string,
    nativeCurrency: metadata.nativeToken,
    rpcUrls: { default: { http: [metadata.publicRpcUrls[0].http] } },
    blockExplorers: metadata.blockExplorers.length
      ? {
          default: {
            name: metadata.blockExplorers[0].name,
            url: metadata.blockExplorers[0].url,
          },
        }
      : undefined,
    testnet: Testnets.includes(metadata.name),
  }),
);

export const chainIdToMetadata = Object.values(chainMetadata).reduce<
  Record<number, ChainMetadata>
>((result, chain) => {
  result[chain.id] = chain;
  return result;
}, {});

export const mainnetChainsMetadata: Array<ChainMetadata> = Mainnets.map(
  (chainName) => chainMetadata[chainName],
);
export const testnetChainsMetadata: Array<ChainMetadata> = Testnets.map(
  (chainName) => chainMetadata[chainName],
);

/**
 * @deprecated use ChainMetadata
 */
export type PartialChainMetadata = {
  id: number;
  finalityBlocks: number;
  nativeTokenDecimals?: number;
  paginate?: RpcPagination;
  // The CoinGecko API expects, in some cases, IDs that do not match
  // ChainNames.
  gasCurrencyCoinGeckoId?: string;
  // URL of the gnosis safe transaction service.
  gnosisSafeTransactionServiceUrl?: string;
};

/**
 * @deprecated use chainMetadata
 */
export const partialChainMetadata: Record<ChainName, PartialChainMetadata> =
  objMap(chainMetadata, (_, metadata) => ({
    id: metadata.id,
    finalityBlocks: metadata.blocks.confirmations,
    nativeTokenDecimals: metadata.nativeToken.decimals,
    paginate: metadata.publicRpcUrls[0]?.pagination,
    gasCurrencyCoinGeckoId: metadata.gasCurrencyCoinGeckoId,
    gnosisSafeTransactionServiceUrl: metadata.gnosisSafeTransactionServiceUrl,
  }));
