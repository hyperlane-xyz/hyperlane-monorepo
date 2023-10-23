import { ProtocolType } from '@hyperlane-xyz/utils';

import { ChainMetadata, ExplorerFamily } from '../metadata/chainMetadataTypes';
import { ChainMap } from '../types';

import { Chains, Mainnets, Testnets } from './chains';

/**
 * Common native currencies
 */
export const avaxToken = { decimals: 18, name: 'Avalanche', symbol: 'AVAX' };
export const bnbToken = { decimals: 18, name: 'BNB', symbol: 'BNB' };
export const celoToken = { decimals: 18, name: 'CELO', symbol: 'CELO' };
export const etherToken = { name: 'Ether', symbol: 'ETH', decimals: 18 };
export const maticToken = { name: 'MATIC', symbol: 'MATIC', decimals: 18 };
export const xDaiToken = { name: 'xDai', symbol: 'xDai', decimals: 18 };
export const solToken = { name: 'Sol', symbol: 'SOL', decimals: 9 };

/**
 * Metadata for Ethereum chains
 */

export const alfajores: ChainMetadata = {
  chainId: 44787,
  domainId: 44787,
  name: Chains.alfajores,
  protocol: ProtocolType.Ethereum,
  displayName: 'Alfajores',
  nativeToken: celoToken,
  rpcUrls: [{ http: 'https://alfajores-forno.celo-testnet.org' }],
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
  domainId: 42161,
  name: Chains.arbitrum,
  protocol: ProtocolType.Ethereum,
  displayName: 'Arbitrum',
  nativeToken: etherToken,
  rpcUrls: [{ http: 'https://arb1.arbitrum.io/rpc' }],
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
    'https://safe-transaction-arbitrum.safe.global/',
};

export const arbitrumgoerli: ChainMetadata = {
  chainId: 421613,
  domainId: 421613,
  name: Chains.arbitrumgoerli,
  protocol: ProtocolType.Ethereum,
  displayName: 'Arbitrum Goerli',
  displayNameShort: 'Arb. Goerli',
  nativeToken: etherToken,
  rpcUrls: [{ http: 'https://goerli-rollup.arbitrum.io/rpc' }],
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
  domainId: 43114,
  name: Chains.avalanche,
  protocol: ProtocolType.Ethereum,
  displayName: 'Avalanche',
  nativeToken: avaxToken,
  rpcUrls: [
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
    'https://safe-transaction-avalanche.safe.global/',
};

export const basegoerli: ChainMetadata = {
  chainId: 84531,
  domainId: 84531,
  name: Chains.basegoerli,
  protocol: ProtocolType.Ethereum,
  displayName: 'Base Goerli',
  nativeToken: etherToken,
  rpcUrls: [
    { http: 'https://base-goerli.publicnode.com' },
    { http: 'https://goerli.base.org' },
  ],
  blockExplorers: [
    {
      name: 'BaseScan',
      url: 'https://goerli.basescan.org',
      apiUrl: 'https://api-goerli.basescan.org/api',
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

export const bsc: ChainMetadata = {
  chainId: 56,
  domainId: 56,
  name: Chains.bsc,
  protocol: ProtocolType.Ethereum,
  displayName: 'Binance Smart Chain',
  displayNameShort: 'Binance',
  nativeToken: bnbToken,
  rpcUrls: [
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
  gnosisSafeTransactionServiceUrl: 'https://safe-transaction-bsc.safe.global/',
};

export const bsctestnet: ChainMetadata = {
  chainId: 97,
  domainId: 97,
  name: Chains.bsctestnet,
  protocol: ProtocolType.Ethereum,
  displayName: 'BSC Testnet',
  nativeToken: bnbToken,
  rpcUrls: [
    { http: 'https://bsc-testnet.publicnode.com' },
    { http: 'https://bsc-testnet.public.blastapi.io' },
    { http: 'https://bsc-testnet.blockpi.network/v1/rpc/public' },
  ],
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

export const chiado: ChainMetadata = {
  chainId: 10200,
  domainId: 10200,
  name: Chains.chiado,
  protocol: ProtocolType.Ethereum,
  displayName: 'Chiado',
  nativeToken: xDaiToken,
  rpcUrls: [{ http: 'https://gnosis-chiado.publicnode.com' }],
  blockExplorers: [
    {
      name: 'GnosisScan',
      url: 'https://gnosis-chiado.blockscout.com',
      apiUrl: 'https://gnosis-chiado.blockscout.com/api',
      family: ExplorerFamily.Blockscout,
    },
  ],
  blocks: {
    confirmations: 1,
    reorgPeriod: 14,
    estimateBlockTime: 5,
  },
  isTestnet: true,
};

export const celo: ChainMetadata = {
  chainId: 42220,
  domainId: 42220,
  name: Chains.celo,
  protocol: ProtocolType.Ethereum,
  displayName: 'Celo',
  nativeToken: celoToken,
  rpcUrls: [{ http: 'https://forno.celo.org' }],
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
  // The official Gnosis safe URL `https://safe-transaction-celo.safe.global` doesn't work well
  // with delegates on a multisig created with the old unofficial Celo tooling.
  gnosisSafeTransactionServiceUrl:
    'https://mainnet-tx-svc.celo-safe-prod.celo-networks-dev.org/',
};

export const ethereum: ChainMetadata = {
  chainId: 1,
  domainId: 1,
  name: Chains.ethereum,
  protocol: ProtocolType.Ethereum,
  displayName: 'Ethereum',
  nativeToken: etherToken,
  rpcUrls: [
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
  gnosisSafeTransactionServiceUrl:
    'https://safe-transaction-mainnet.safe.global/',
};

export const fuji: ChainMetadata = {
  chainId: 43113,
  domainId: 43113,
  name: Chains.fuji,
  protocol: ProtocolType.Ethereum,
  displayName: 'Fuji',
  nativeToken: avaxToken,
  rpcUrls: [
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
  domainId: 5,
  name: Chains.goerli,
  protocol: ProtocolType.Ethereum,
  displayName: 'Goerli',
  nativeToken: etherToken,
  rpcUrls: [
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

export const lineagoerli: ChainMetadata = {
  chainId: 59140,
  domainId: 59140,
  name: Chains.lineagoerli,
  protocol: ProtocolType.Ethereum,
  displayName: 'Linea Goerli',
  nativeToken: etherToken,
  rpcUrls: [{ http: 'https://rpc.goerli.linea.build' }],
  blockExplorers: [
    {
      name: 'Linea Explorer',
      url: 'https://explorer.goerli.linea.build/',
      apiUrl: 'https://explorer.goerli.linea.build/api',
      family: ExplorerFamily.Blockscout,
    },
  ],
  blocks: {
    confirmations: 1,
    reorgPeriod: 2,
    estimateBlockTime: 12,
  },
  isTestnet: true,
};

export const sepolia: ChainMetadata = {
  chainId: 11155111,
  domainId: 11155111,
  name: Chains.sepolia,
  protocol: ProtocolType.Ethereum,
  displayName: 'Sepolia',
  nativeToken: etherToken,
  rpcUrls: [
    { http: 'https://ethereum-sepolia.blockpi.network/v1/rpc/public' },
    { http: 'https://eth-sepolia.g.alchemy.com/v2/demo' },
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

export const scrollsepolia: ChainMetadata = {
  chainId: 534351,
  domainId: 534351,
  name: Chains.scrollsepolia,
  protocol: ProtocolType.Ethereum,
  displayName: 'Scroll Sepolia',
  nativeToken: etherToken,
  rpcUrls: [
    { http: 'https://sepolia-rpc.scroll.io' },
    { http: 'https://scroll-public.scroll-testnet.quiknode.pro' },
  ],
  blockExplorers: [
    {
      name: 'Scroll Explorer',
      url: 'https://sepolia.scrollscan.dev/',
      apiUrl: 'https://api-sepolia.scrollscan.com/api',
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

export const moonbasealpha: ChainMetadata = {
  chainId: 1287,
  domainId: 1287,
  name: Chains.moonbasealpha,
  protocol: ProtocolType.Ethereum,
  displayName: 'Moonbase Alpha',
  displayNameShort: 'Moonbase',
  nativeToken: {
    decimals: 18,
    name: 'DEV',
    symbol: 'DEV',
  },
  rpcUrls: [{ http: 'https://rpc.api.moonbase.moonbeam.network' }],
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
  domainId: 1284,
  name: Chains.moonbeam,
  protocol: ProtocolType.Ethereum,
  displayName: 'Moonbeam',
  nativeToken: {
    decimals: 18,
    name: 'GLMR',
    symbol: 'GLMR',
  },
  rpcUrls: [{ http: 'https://rpc.api.moonbeam.network' }],
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
  domainId: 80001,
  name: Chains.mumbai,
  protocol: ProtocolType.Ethereum,
  displayName: 'Mumbai',
  nativeToken: maticToken,
  rpcUrls: [
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
  domainId: 10,
  name: Chains.optimism,
  protocol: ProtocolType.Ethereum,
  displayName: 'Optimism',
  nativeToken: etherToken,
  rpcUrls: [{ http: 'https://mainnet.optimism.io' }],
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
    'https://safe-transaction-optimism.safe.global/',
};

export const optimismgoerli: ChainMetadata = {
  chainId: 420,
  domainId: 420,
  name: Chains.optimismgoerli,
  protocol: ProtocolType.Ethereum,
  displayName: 'Optimism Goerli',
  displayNameShort: 'Opt. Goerli',
  nativeToken: etherToken,
  rpcUrls: [{ http: 'https://goerli.optimism.io' }],
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
  domainId: 137,
  name: Chains.polygon,
  protocol: ProtocolType.Ethereum,
  displayName: 'Polygon',
  nativeToken: etherToken,
  rpcUrls: [
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
    'https://safe-transaction-polygon.safe.global/',
};

export const gnosis: ChainMetadata = {
  chainId: 100,
  domainId: 100,
  name: Chains.gnosis,
  protocol: ProtocolType.Ethereum,
  displayName: 'Gnosis',
  nativeToken: xDaiToken,
  rpcUrls: [
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
  gnosisSafeTransactionServiceUrl:
    'https://safe-transaction-gnosis-chain.safe.global/',
};

// Testnet for Nautilus
export const proteustestnet: ChainMetadata = {
  chainId: 88002,
  domainId: 88002,
  name: Chains.proteustestnet,
  protocol: ProtocolType.Ethereum,
  displayName: 'Proteus Testnet',
  nativeToken: {
    name: 'Zebec',
    symbol: 'ZBC',
    decimals: 18,
  },
  rpcUrls: [
    {
      http: 'https://api.proteus.nautchain.xyz/solana',
    },
  ],
  blocks: {
    confirmations: 1,
    reorgPeriod: 1,
    estimateBlockTime: 1,
  },
};

export const nautilus: ChainMetadata = {
  chainId: 22222,
  domainId: 22222,
  name: Chains.nautilus,
  protocol: ProtocolType.Ethereum,
  displayName: 'Nautilus',
  nativeToken: {
    name: 'Zebec',
    symbol: 'ZBC',
    decimals: 18,
  },
  rpcUrls: [
    {
      http: 'https://api.nautilus.nautchain.xyz',
    },
  ],
  blocks: {
    confirmations: 1,
    reorgPeriod: 1,
    estimateBlockTime: 1,
  },
};

/**
 * Metadata for local test chains
 */

export const test1: ChainMetadata = {
  chainId: 13371,
  domainId: 13371,
  name: Chains.test1,
  protocol: ProtocolType.Ethereum,
  displayName: 'Test 1',
  nativeToken: etherToken,
  rpcUrls: [{ http: 'http://127.0.0.1:8545' }],
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
  domainId: 13372,
  name: Chains.test2,
  protocol: ProtocolType.Ethereum,
  displayName: 'Test 2',
  nativeToken: etherToken,
  rpcUrls: [{ http: 'http://127.0.0.1:8545' }],
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
  domainId: 13373,
  name: Chains.test3,
  protocol: ProtocolType.Ethereum,
  displayName: 'Test 3',
  nativeToken: etherToken,
  rpcUrls: [{ http: 'http://127.0.0.1:8545' }],
  blockExplorers: [],
  blocks: {
    confirmations: 1,
    reorgPeriod: 2,
    estimateBlockTime: 3,
  },
  isTestnet: true,
};

/**
 * Metadata for Sealevel chains
 */

export const solana: ChainMetadata = {
  protocol: ProtocolType.Sealevel,
  // Uses the same ChainId as https://www.alchemy.com/chain-connect/chain/solana
  chainId: 1399811149,
  domainId: 1399811149,
  name: 'solana',
  displayName: 'Solana',
  nativeToken: solToken,
  rpcUrls: [{ http: 'https://api.mainnet-beta.solana.com' }],
  blockExplorers: [
    {
      name: 'Solana Explorer',
      url: 'https://explorer.solana.com',
      apiUrl: 'https://explorer.solana.com',
      family: ExplorerFamily.Other,
    },
  ],
  blocks: {
    confirmations: 1,
    reorgPeriod: 0,
    estimateBlockTime: 0.4,
  },
};

export const solanatestnet: ChainMetadata = {
  protocol: ProtocolType.Sealevel,
  chainId: 1399811150,
  domainId: 1399811150,
  name: 'solanatestnet',
  displayName: 'Solana Testnet',
  displayNameShort: 'Sol Testnet',
  nativeToken: solToken,
  rpcUrls: [{ http: 'https://api.testnet.solana.com' }],
  blockExplorers: [
    {
      name: 'Solana Explorer',
      url: 'https://explorer.solana.com',
      apiUrl: 'https://explorer.solana.com',
      family: ExplorerFamily.Other,
    },
  ],
  blocks: {
    confirmations: 1,
    reorgPeriod: 0,
    estimateBlockTime: 0.4,
  },
  isTestnet: true,
};

export const solanadevnet: ChainMetadata = {
  protocol: ProtocolType.Sealevel,
  chainId: 1399811151,
  domainId: 1399811151,
  name: 'solanadevnet',
  displayName: 'Solana Devnet',
  displayNameShort: 'Sol Devnet',
  nativeToken: solToken,
  rpcUrls: [{ http: 'https://api.devnet.solana.com' }],
  blockExplorers: [
    {
      name: 'Solana Explorer',
      url: 'https://explorer.solana.com',
      apiUrl: 'https://explorer.solana.com',
      family: ExplorerFamily.Other,
    },
  ],
  blocks: {
    confirmations: 1,
    reorgPeriod: 0,
    estimateBlockTime: 0.4,
  },
  isTestnet: true,
};

export const polygonzkevmtestnet: ChainMetadata = {
  protocol: ProtocolType.Ethereum,
  chainId: 1442,
  domainId: 1442,
  name: Chains.polygonzkevmtestnet,
  displayName: 'Polygon zkEVM Testnet',
  nativeToken: etherToken,
  rpcUrls: [{ http: 'https://rpc.public.zkevm-test.net' }],
  blockExplorers: [
    {
      name: 'PolygonScan',
      url: 'https://testnet-zkevm.polygonscan.com/',
      apiUrl: 'https://api-testnet-zkevm.polygonscan.com/api',
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

/**
 * Collection maps
 *
 * NOTE: When adding chains here, consider also adding the
 * corresponding chain logo images in the /sdk/logos/* folders
 */
export const chainMetadata: ChainMap<ChainMetadata> = {
  alfajores,
  arbitrum,
  arbitrumgoerli,
  avalanche,
  basegoerli,
  bsc,
  bsctestnet,
  chiado,
  celo,
  ethereum,
  fuji,
  goerli,
  lineagoerli,
  scrollsepolia,
  sepolia,
  moonbasealpha,
  moonbeam,
  mumbai,
  optimism,
  optimismgoerli,
  polygon,
  polygonzkevmtestnet,
  gnosis,
  proteustestnet,
  test1,
  test2,
  test3,
  solana,
  solanatestnet,
  solanadevnet,
  nautilus,
};

export const chainIdToMetadata = Object.values(chainMetadata).reduce<
  ChainMap<ChainMetadata>
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

export const solanaChainToClusterName: ChainMap<string> = {
  solana: 'mainnet-beta',
  solanatestnet: 'testnet',
  solanadevnet: 'devnet',
};
