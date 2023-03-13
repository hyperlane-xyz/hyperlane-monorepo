import type { Chain as WagmiChain } from '@wagmi/chains';
import type { providers } from 'ethers';
import { z } from 'zod';

import { ChainName } from '../types';
import { objMap } from '../utils/objects';
import { chainMetadataToWagmiChain } from '../utils/wagmi';

import { Chains, Mainnets, Testnets } from './chains';

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
  chainId: number;
  /** Hyperlane domain, only required if differs from id above */
  domainId?: number;
  name: ChainName;
  /** Human-readable name */
  displayName?: string;
  /** Shorter human-readable name */
  displayNameShort?: string;
  /** Default currency/token used by chain */
  nativeToken?: {
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
  blockExplorers?: Array<{
    name: string;
    url: string;
    apiUrl?: string;
    apiKey?: string;
    family?: ExplorerFamily;
  }>;
  blocks?: {
    /** Number of blocks to wait before considering a transaction confirmed */
    confirmations: number;
    //  TODO consider merging with confirmations, requires agent code changes */
    /** Number of blocks before a transaction has a near-zero chance of reverting */
    reorgPeriod?: number;
    /** Rough estimate of time per block in seconds */
    estimateBlockTime?: number;
  };
  transactionOverrides?: Partial<providers.TransactionRequest>;
  /** The CoinGecko API sometimes expects IDs that do not match ChainNames */
  gasCurrencyCoinGeckoId?: string;
  /** URL of the gnosis safe transaction service */
  gnosisSafeTransactionServiceUrl?: string;
  /** Is chain a testnet or a mainnet */
  isTestnet?: boolean;
}

export interface RpcPagination {
  blocks: number;
  from: number;
}

/**
 * Zod schema for ChainMetadata validation
 * Keep in sync with ChainMetadata above
 */
export const ChainMetadataSchema = z.object({
  chainId: z.number(),
  domainId: z.number().optional(),
  name: z.string(),
  displayName: z.string().optional(),
  displayNameShort: z.string().optional(),
  nativeToken: z
    .object({
      name: z.string(),
      symbol: z.string(),
      decimals: z.number(),
    })
    .optional(),
  publicRpcUrls: z
    .array(
      z.object({
        http: z.string().url(),
        webSocket: z.string().optional(),
        pagination: z
          .object({
            blocks: z.number(),
            from: z.number(),
          })
          .optional(),
      }),
    )
    .nonempty(),
  blockExplorers: z
    .array(
      z.object({
        name: z.string(),
        url: z.string().url(),
        apiUrl: z.string().url().optional(),
        apiKey: z.string().optional(),
        family: z.string().optional(),
      }),
    )
    .optional(),
  blocks: z
    .object({
      confirmations: z.number(),
      reorgPeriod: z.number().optional(),
      estimateBlockTime: z.number().optional(),
    })
    .optional(),
  transactionOverrides: z.object({}).optional(),
  gasCurrencyCoinGeckoId: z.string().optional(),
  gnosisSafeTransactionServiceUrl: z.string().optional(),
  isTestnet: z.boolean().optional(),
});

/**
 * Common native currencies
 */
export const avaxToken = {
  decimals: 18,
  name: 'Avalanche',
  symbol: 'AVAX',
};
export const bnbToken = {
  decimals: 18,
  name: 'BNB',
  symbol: 'BNB',
};
export const celoToken = {
  decimals: 18,
  name: 'CELO',
  symbol: 'CELO',
};
export const etherToken = { name: 'Ether', symbol: 'ETH', decimals: 18 };
export const maticToken = { name: 'MATIC', symbol: 'MATIC', decimals: 18 };
export const xDaiToken = { name: 'xDai', symbol: 'xDai', decimals: 18 };

/**
 * Chain metadata
 */

export const alfajores: ChainMetadata = {
  chainId: 44787,
  name: Chains.alfajores,
  displayName: 'Alfajores',
  nativeToken: celoToken,
  publicRpcUrls: [{ http: 'https://alfajores-forno.celo-testnet.org' }],
  blockExplorers: [
    {
      name: 'CeloScan',
      url: 'https://alfajores.celoscan.io',
      apiUrl: 'https://api-alfajores.celoscan.io/api',
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
  isTestnet: true,
};

export const arbitrum: ChainMetadata = {
  chainId: 42161,
  name: Chains.arbitrum,
  displayName: 'Arbitrum',
  nativeToken: etherToken,
  publicRpcUrls: [{ http: 'https://arb1.arbitrum.io/rpc' }],
  blockExplorers: [
    {
      name: 'Arbiscan',
      url: 'https://arbiscan.io',
      apiUrl: 'https://api.arbiscan.io/api',
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
  chainId: 421613,
  name: Chains.arbitrumgoerli,
  displayName: 'Arbitrum Goerli',
  displayNameShort: 'Arb. Goerli',
  nativeToken: etherToken,
  publicRpcUrls: [{ http: 'https://goerli-rollup.arbitrum.io/rpc' }],
  blockExplorers: [
    {
      name: 'Arbiscan',
      url: 'https://goerli.arbiscan.io',
      apiUrl: 'https://api-goerli.arbiscan.io/api',
      family: ExplorerFamily.Etherscan,
    },
  ],
  blocks: {
    confirmations: 1,
    reorgPeriod: 1,
    estimateBlockTime: 3,
  },
  isTestnet: true,
};

export const avalanche: ChainMetadata = {
  chainId: 43114,
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
      apiUrl: 'https://api.snowtrace.io/api',
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
  chainId: 56,
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
      apiUrl: 'https://api.bscscan.com/api',
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
  chainId: 97,
  name: Chains.bsctestnet,
  displayName: 'BSC Testnet',
  nativeToken: bnbToken,
  publicRpcUrls: [{ http: 'https://data-seed-prebsc-1-s3.binance.org:8545' }],
  blockExplorers: [
    {
      name: 'BscScan',
      url: 'https://testnet.bscscan.com',
      apiUrl: 'https://api-testnet.bscscan.com/api',
      family: ExplorerFamily.Etherscan,
    },
  ],
  blocks: {
    confirmations: 1,
    reorgPeriod: 9,
    estimateBlockTime: 3,
  },
  isTestnet: true,
};

export const celo: ChainMetadata = {
  chainId: 42220,
  name: Chains.celo,
  displayName: 'Celo',
  nativeToken: celoToken,
  publicRpcUrls: [{ http: 'https://forno.celo.org' }],
  blockExplorers: [
    {
      name: 'CeloScan',
      url: 'https://celoscan.io',
      apiUrl: 'https://api.celoscan.io/api',
      family: ExplorerFamily.Etherscan,
    },
    {
      name: 'Blockscout',
      url: 'https://explorer.celo.org',
      apiUrl: 'https://explorer.celo.org/mainnet/api',
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
  chainId: 1,
  name: Chains.ethereum,
  displayName: 'Ethereum',
  nativeToken: etherToken,
  publicRpcUrls: [{ http: 'https://cloudflare-eth.com' }],
  blockExplorers: [
    {
      name: 'Etherscan',
      url: 'https://etherscan.io',
      apiUrl: 'https://api.etherscan.io/api',
      family: ExplorerFamily.Etherscan,
    },
    {
      name: 'Blockscout',
      url: 'https://blockscout.com/eth/mainnet',
      apiUrl: 'https://blockscout.com/eth/mainnet/api',
      family: ExplorerFamily.Blockscout,
    },
  ],
  blocks: {
    confirmations: 7,
    reorgPeriod: 14,
    estimateBlockTime: 13,
  },
  gnosisSafeTransactionServiceUrl: 'https://safe-transaction.gnosis.io',
};

export const fuji: ChainMetadata = {
  chainId: 43113,
  name: Chains.fuji,
  displayName: 'Fuji',
  nativeToken: avaxToken,
  publicRpcUrls: [{ http: 'https://api.avax-test.network/ext/bc/C/rpc' }],
  blockExplorers: [
    {
      name: 'SnowTrace',
      url: 'https://testnet.snowtrace.io',
      apiUrl: 'https://api-testnet.snowtrace.io/api',
      family: ExplorerFamily.Other,
    },
  ],
  blocks: {
    confirmations: 3,
    reorgPeriod: 3,
    estimateBlockTime: 2,
  },
  isTestnet: true,
};

export const goerli: ChainMetadata = {
  chainId: 5,
  name: Chains.goerli,
  displayName: 'Goerli',
  nativeToken: etherToken,
  publicRpcUrls: [
    { http: 'https://endpoints.omniatech.io/v1/eth/goerli/public' },
    { http: 'https://rpc.ankr.com/eth_goerli' },
    { http: 'https://eth-goerli.public.blastapi.io' },
  ],
  blockExplorers: [
    {
      name: 'Etherscan',
      url: 'https://goerli.etherscan.io',
      apiUrl: 'https://api-goerli.etherscan.io/api',
      family: ExplorerFamily.Etherscan,
    },
  ],
  blocks: {
    confirmations: 1,
    reorgPeriod: 2,
    estimateBlockTime: 13,
  },
  isTestnet: true,
};

export const moonbasealpha: ChainMetadata = {
  chainId: 1287,
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
      apiUrl: 'https://api-moonbase.moonscan.io/api',
      family: ExplorerFamily.Etherscan,
    },
  ],
  blocks: {
    confirmations: 1,
    reorgPeriod: 1,
    estimateBlockTime: 12,
  },
  isTestnet: true,
};

export const moonbeam: ChainMetadata = {
  chainId: 1284,
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
      apiUrl: 'https://api-moonbeam.moonscan.io/api',
      family: ExplorerFamily.Etherscan,
    },
  ],
  blocks: {
    confirmations: 1,
    reorgPeriod: 1,
    estimateBlockTime: 12,
  },
  gnosisSafeTransactionServiceUrl:
    'https://transaction.multisig.moonbeam.network',
};

export const mumbai: ChainMetadata = {
  chainId: 80001,
  name: Chains.mumbai,
  displayName: 'Mumbai',
  nativeToken: maticToken,
  publicRpcUrls: [
    {
      http: 'https://rpc.ankr.com/polygon_mumbai',
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
      apiUrl: 'https://api-testnet.polygonscan.com/api',
      family: ExplorerFamily.Etherscan,
    },
  ],
  blocks: {
    confirmations: 3,
    reorgPeriod: 32,
    estimateBlockTime: 5,
  },
  isTestnet: true,
};

export const optimism: ChainMetadata = {
  chainId: 10,
  name: Chains.optimism,
  displayName: 'Optimism',
  nativeToken: etherToken,
  publicRpcUrls: [{ http: 'https://mainnet.optimism.io' }],
  blockExplorers: [
    {
      name: 'Etherscan',
      url: 'https://optimistic.etherscan.io',
      apiUrl: 'https://api-optimistic.etherscan.io/api',
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
  chainId: 420,
  name: Chains.optimismgoerli,
  displayName: 'Optimism Goerli',
  displayNameShort: 'Opt. Goerli',
  nativeToken: etherToken,
  publicRpcUrls: [{ http: 'https://goerli.optimism.io' }],
  blockExplorers: [
    {
      name: 'Etherscan',
      url: 'https://goerli-optimism.etherscan.io',
      apiUrl: 'https://api-goerli-optimism.etherscan.io/api',
      family: ExplorerFamily.Etherscan,
    },
  ],
  blocks: {
    confirmations: 1,
    reorgPeriod: 1,
    estimateBlockTime: 3,
  },
  isTestnet: true,
};

export const polygon: ChainMetadata = {
  chainId: 137,
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
      apiUrl: 'https://api.polygonscan.com/api',
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

export const gnosis: ChainMetadata = {
  chainId: 100,
  name: Chains.gnosis,
  displayName: 'Gnosis',
  nativeToken: xDaiToken,
  publicRpcUrls: [
    {
      http: 'https://rpc.gnosischain.com',
      pagination: {
        blocks: 10000,
        from: 25997478,
      },
    },
  ],
  blockExplorers: [
    {
      name: 'GnosisScan',
      url: 'https://gnosisscan.io',
      apiUrl: 'https://api.gnosisscan.io/api',
      family: ExplorerFamily.Etherscan,
    },
  ],
  blocks: {
    confirmations: 1,
    reorgPeriod: 14,
    estimateBlockTime: 5,
  },
  gasCurrencyCoinGeckoId: 'xdai',
  gnosisSafeTransactionServiceUrl: 'https://safe-transaction.xdai.gnosis.io/',
};

export const test1: ChainMetadata = {
  chainId: 13371,
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
  isTestnet: true,
};

export const test2: ChainMetadata = {
  chainId: 13372,
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
  isTestnet: true,
};

export const test3: ChainMetadata = {
  chainId: 13373,
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
  isTestnet: true,
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
  gnosis,
  test1,
  test2,
  test3,
} as Record<ChainName, ChainMetadata>;

// For convenient use in wagmi-based apps
export const wagmiChainMetadata: Record<ChainName, WagmiChain> = objMap(
  chainMetadata,
  (_, metadata) => chainMetadataToWagmiChain(metadata),
);

export const chainIdToMetadata = Object.values(chainMetadata).reduce<
  Record<number, ChainMetadata>
>((result, chain) => {
  result[chain.chainId] = chain;
  return result;
}, {});

export const mainnetChainsMetadata: Array<ChainMetadata> = Mainnets.map(
  (chainName) => chainMetadata[chainName],
);
export const testnetChainsMetadata: Array<ChainMetadata> = Testnets.map(
  (chainName) => chainMetadata[chainName],
);

export function isValidChainMetadata(c: ChainMetadata): boolean {
  return ChainMetadataSchema.safeParse(c).success;
}
