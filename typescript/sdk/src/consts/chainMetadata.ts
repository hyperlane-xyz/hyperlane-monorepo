import type { Chain as WagmiChain } from '@wagmi/chains';
import type { providers } from 'ethers';
import { z } from 'zod';

import type { types } from '@hyperlane-xyz/utils';

import type { RetryProviderOptions } from '../providers/RetryProvider';
import { ChainName } from '../types';
import { objMap } from '../utils/objects';
import { chainMetadataToWagmiChain } from '../utils/wagmi';

import { Chains, Mainnets, Testnets } from './chains';

export enum ExplorerFamily {
  Etherscan = 'etherscan',
  Blockscout = 'blockscout',
  Other = 'other',
}
export type ExplorerFamilyType = `${ExplorerFamily}`;

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
    pagination?: RpcPaginationOptions;
    retry?: RetryProviderOptions;
  }>;
  /** Collection of block explorers */
  blockExplorers?: Array<{
    name: string;
    url: string;
    apiUrl: string;
    apiKey?: string;
    family?: ExplorerFamilyType;
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
  /** Settings to use when forming transaction requests */
  transactionOverrides?: Partial<providers.TransactionRequest>;
  /** Address for Ethereum Name Service registry */
  ensAddress?: types.Address;
  /** The CoinGecko API sometimes expects IDs that do not match ChainNames */
  gasCurrencyCoinGeckoId?: string;
  /** URL of the gnosis safe transaction service */
  gnosisSafeTransactionServiceUrl?: string;
  /** Is chain a testnet or a mainnet */
  isTestnet?: boolean;
}

export interface RpcPaginationOptions {
  /** Maximum number of blocks to query between (e.g. for fetching logs) */
  maxBlockRange?: number;
  /** Absolute lowest block number from which to query */
  minBlockNumber?: number;
  /** Relative num blocks from latest from which to query */
  maxBlockAge?: number;
}

/**
 * Zod schema for ChainMetadata validation
 * Keep in sync with ChainMetadata above
 */
export const ChainMetadataSchema = z.object({
  chainId: z.number().positive().describe(`The chainId of the chain.`),
  domainId: z
    .number()
    .positive()
    .optional()
    .describe(
      'The domainId of the chain, should generally default to `chainId`. Consumer of `ChainMetadata` should use this value if present, but otherwise fallback to `chainId`.',
    ),
  name: z
    .string()
    .describe(
      `The string identifier of the chain, used as the key in dictornaries.`,
    ),
  displayName: z
    .string()
    .optional()
    .describe(`Human-readable name of the chain.`),
  displayNameShort: z
    .string()
    .optional()
    .describe(`Shorter human-readable name of the chain.`),
  nativeToken: z
    .object({
      name: z.string(),
      symbol: z.string(),
      decimals: z.number().positive(),
    })
    .optional(),
  rpcUrls: z
    .array(
      z.object({
        http: z.string().url().describe(`The HTTP RPC endpoint URL.`),
        webSocket: z
          .string()
          .optional()
          .describe(`The WebSocket RPC endpoint URL.`),
        pagination: z
          .object({
            maxBlockRange: z
              .number()
              .positive()
              .optional()
              .describe(
                'The maximum number of blocks that this RPC supports getting logs for.',
              ),
            minBlockNumber: z.number().positive().optional(),
            maxBlockAge: z.number().positive().optional(),
          })
          .optional()
          .describe(`Pagination options for the RPC endpoint.`),
        retry: z
          .object({
            maxRequests: z
              .number()
              .positive()
              .describe(
                'The maximum number of requests to make before giving up.',
              ),
            baseRetryMs: z
              .number()
              .positive()
              .describe('The base retry time in milliseconds.'),
          })
          .optional()
          .describe('Retry options for the RPC endpoint.'),
      }),
    )
    .nonempty(),
  blockExplorers: z
    .array(
      z.object({
        name: z.string(),
        url: z.string().url(),
        apiUrl: z.string().url(),
        apiKey: z.string().optional(),
        family: z.nativeEnum(ExplorerFamily).optional(),
      }),
    )
    .optional()
    .describe(`Block explorers for the chain.`),
  blocks: z
    .object({
      confirmations: z
        .number()
        .describe(
          `Number of blocks to wait before considering a transaction confirmed.`,
        ),
      reorgPeriod: z
        .number()
        .optional()
        .describe(
          'Number of blocks before a transaction has a near-zero chance of reverting.',
        ),
      estimateBlockTime: z
        .number()
        .positive()
        .optional()
        .describe('Rough estimate of time per block in seconds.'),
    })
    .optional()
    .describe(`Block settings for the chain/deployment.`),
  transactionOverrides: z.object({}).optional(),
  gasCurrencyCoinGeckoId: z.string().optional(),
  gnosisSafeTransactionServiceUrl: z.string().optional(),
  isTestnet: z.boolean().optional(),
});

export const HyperlaneDeploymentArtifacts = z.object({
  mailbox: z.string().describe(`The mailbox address for the chain.`),
  interchainGasPaymaster: z
    .string()
    .describe(`The interchain gas paymaster address for the chain.`),
  validatorAnnounce: z
    .string()
    .describe(`The validator announce address for the chain.`),

  index: z.object({
    from: z
      .number()
      .default(1999)
      .describe('The starting block from which to index events.'),
    chunk: z
      .number()
      .default(1000)
      .describe('The number of blocks to index per chunk.'),
  }),
});

export const AgentChainMetadataSchema = ChainMetadataSchema.extend(
  HyperlaneDeploymentArtifacts.shape,
).extend({
  protocol: z
    .enum(['ethereum', 'fuel'])
    .default('ethereum')
    .describe('The VM type of the chain, defaults to "ethereum" for EVM'),

  rpcConsensusType: z
    .enum(['fallback', 'quorum'])
    .default('fallback')
    .describe(
      'The consensus type to use when multiple RPCs are configured. `fallback` will use the first RPC that returns a result, `quorum` will require a majority of RPCs to return the same result. Different consumers may choose to default to different values here, i.e. validators may want to default to `quorum` while relayers may want to default to `fallback`.',
    ),
  overrideRpcUrls: z
    .string()
    .optional()
    .describe(
      `This is a hacky way to allow for a comma-separated list of RPC URLs to be specified without a complex "path" in the agent configuration scheme. Agents should check for the existence of this field first and use that in conjunction with 'rpcConsensusType' if it exists, otherwise fall back to 'rpcUrls'.`,
    ),
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
      apiUrl: 'https://explorer.celo.org/alfajores/api',
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
        maxBlockRange: 100000,
        minBlockNumber: 6765067,
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
  publicRpcUrls: [
    { http: 'https://mainnet.infura.io/v3/9aa3d95b3bc440fa88ea12eaa4456161' },
    { http: 'https://cloudflare-eth.com' },
  ],
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
  publicRpcUrls: [
    {
      http: 'https://api.avax-test.network/ext/bc/C/rpc',
      pagination: { maxBlockRange: 2048 },
    },
  ],
  blockExplorers: [
    {
      name: 'SnowTrace',
      url: 'https://testnet.snowtrace.io',
      apiUrl: 'https://api-testnet.snowtrace.io/api',
      family: ExplorerFamily.Etherscan,
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
    { http: 'https://goerli.infura.io/v3/9aa3d95b3bc440fa88ea12eaa4456161' },
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

export const sepolia: ChainMetadata = {
  chainId: 11155111,
  name: Chains.sepolia,
  displayName: 'Sepolia',
  nativeToken: etherToken,
  publicRpcUrls: [
    { http: 'https://endpoints.omniatech.io/v1/eth/sepolia/public' },
    { http: 'https://rpc.sepolia.org' },
  ],
  blockExplorers: [
    {
      name: 'Etherscan',
      url: 'https://sepolia.etherscan.io',
      apiUrl: 'https://api-sepolia.etherscan.io/api',
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
    confirmations: 2,
    reorgPeriod: 2,
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
        maxBlockRange: 10000,
        minBlockNumber: 22900000,
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
        maxBlockRange: 10000,
        minBlockNumber: 19657100,
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
        maxBlockRange: 10000,
        minBlockNumber: 25997478,
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
  sepolia,
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
