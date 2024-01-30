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
export const etherToken = { decimals: 18, name: 'Ether', symbol: 'ETH' };
export const maticToken = { decimals: 18, name: 'MATIC', symbol: 'MATIC' };
export const xDaiToken = { decimals: 18, name: 'xDai', symbol: 'xDai' };
export const solToken = { decimals: 9, name: 'Sol', symbol: 'SOL' };

export const alfajores: ChainMetadata = {
  blockExplorers: [
    {
      apiUrl: 'https://api-alfajores.celoscan.io/api',
      family: ExplorerFamily.Etherscan,
      name: 'CeloScan',
      url: 'https://alfajores.celoscan.io',
    },
    {
      apiUrl: 'https://explorer.celo.org/alfajores/api',
      family: ExplorerFamily.Blockscout,
      name: 'Blockscout',
      url: 'https://explorer.celo.org/alfajores',
    },
  ],
  blocks: {
    confirmations: 1,
    estimateBlockTime: 5,
    reorgPeriod: 0,
  },
  chainId: 44787,
  displayName: 'Alfajores',
  domainId: 44787,
  isTestnet: true,
  name: Chains.alfajores,
  nativeToken: celoToken,
  protocol: ProtocolType.Ethereum,
  rpcUrls: [{ http: 'https://alfajores-forno.celo-testnet.org' }],
};

export const arbitrum: ChainMetadata = {
  blockExplorers: [
    {
      apiUrl: 'https://api.arbiscan.io/api',
      family: ExplorerFamily.Etherscan,
      name: 'Arbiscan',
      url: 'https://arbiscan.io',
    },
  ],
  blocks: {
    confirmations: 1,
    estimateBlockTime: 3,
    reorgPeriod: 0,
  },
  chainId: 42161,
  displayName: 'Arbitrum',
  domainId: 42161,
  gasCurrencyCoinGeckoId: 'ethereum',
  // ETH is used for gas
  gnosisSafeTransactionServiceUrl:
    'https://safe-transaction-arbitrum.safe.global/',
  name: Chains.arbitrum,
  nativeToken: etherToken,
  protocol: ProtocolType.Ethereum,
  rpcUrls: [{ http: 'https://arb1.arbitrum.io/rpc' }],
};

export const arbitrumgoerli: ChainMetadata = {
  blocks: {
    confirmations: 1,
    estimateBlockTime: 3,
    reorgPeriod: 1,
  },
  chainId: 421613,
  displayName: 'Arbitrum Goerli',
  displayNameShort: 'Arb. Goerli',
  domainId: 421613,
  isTestnet: true,
  name: Chains.arbitrumgoerli,
  nativeToken: etherToken,
  protocol: ProtocolType.Ethereum,
  rpcUrls: [{ http: 'https://goerli-rollup.arbitrum.io/rpc' }],
};

export const avalanche: ChainMetadata = {
  blockExplorers: [
    {
      apiUrl: 'https://api.snowtrace.io/api',
      family: ExplorerFamily.Other,
      name: 'SnowTrace',
      url: 'https://snowtrace.io',
    },
  ],
  blocks: {
    confirmations: 3,
    estimateBlockTime: 2,
    reorgPeriod: 3,
  },
  chainId: 43114,
  displayName: 'Avalanche',
  domainId: 43114,
  gasCurrencyCoinGeckoId: 'avalanche-2',
  gnosisSafeTransactionServiceUrl:
    'https://safe-transaction-avalanche.safe.global/',
  name: Chains.avalanche,
  nativeToken: avaxToken,
  protocol: ProtocolType.Ethereum,
  rpcUrls: [
    {
      http: 'https://api.avax.network/ext/bc/C/rpc',
      pagination: {
        maxBlockRange: 100000,
        minBlockNumber: 6765067,
      },
    },
  ],
};

export const base: ChainMetadata = {
  blockExplorers: [
    {
      apiUrl: 'https://api.basescan.org/api',
      family: ExplorerFamily.Etherscan,
      name: 'BaseScan',
      url: 'https://basescan.org',
    },
  ],
  // ETH is used for gas
  blocks: {
    confirmations: 1,
    estimateBlockTime: 2,
    reorgPeriod: 1,
  },
  chainId: 8453,
  displayName: 'Base',
  domainId: 8453,
  gasCurrencyCoinGeckoId: 'ethereum',
  gnosisSafeTransactionServiceUrl: 'https://safe-transaction-base.safe.global/',
  name: Chains.base,
  nativeToken: etherToken,
  protocol: ProtocolType.Ethereum,
  rpcUrls: [
    { http: 'https://base.publicnode.com/' },
    { http: 'https://mainnet.base.org' },
    { http: 'https://base.blockpi.network/v1/rpc/public' },
  ],
};

export const basegoerli: ChainMetadata = {
  blockExplorers: [
    {
      apiUrl: 'https://api-goerli.basescan.org/api',
      family: ExplorerFamily.Etherscan,
      name: 'BaseScan',
      url: 'https://goerli.basescan.org',
    },
  ],
  blocks: {
    confirmations: 1,
    estimateBlockTime: 3,
    reorgPeriod: 1,
  },
  chainId: 84531,
  displayName: 'Base Goerli',
  domainId: 84531,
  isTestnet: true,
  name: Chains.basegoerli,
  nativeToken: etherToken,
  protocol: ProtocolType.Ethereum,
  rpcUrls: [
    { http: 'https://base-goerli.publicnode.com' },
    { http: 'https://goerli.base.org' },
  ],
};

export const bsc: ChainMetadata = {
  blockExplorers: [
    {
      apiUrl: 'https://api.bscscan.com/api',
      family: ExplorerFamily.Etherscan,
      name: 'BscScan',
      url: 'https://bscscan.com',
    },
  ],
  blocks: {
    confirmations: 1,
    estimateBlockTime: 3,
    reorgPeriod: 15,
  },
  chainId: 56,
  displayName: 'Binance Smart Chain',
  displayNameShort: 'Binance',
  domainId: 56,
  gasCurrencyCoinGeckoId: 'binancecoin',
  gnosisSafeTransactionServiceUrl: 'https://safe-transaction-bsc.safe.global/',
  name: Chains.bsc,
  nativeToken: bnbToken,
  protocol: ProtocolType.Ethereum,
  rpcUrls: [
    { http: 'https://rpc.ankr.com/bsc' },
    { http: 'https://bsc.drpc.org' },
    { http: 'https://bscrpc.com' },
  ],
};

export const bsctestnet: ChainMetadata = {
  blockExplorers: [
    {
      apiUrl: 'https://api-testnet.bscscan.com/api',
      family: ExplorerFamily.Etherscan,
      name: 'BscScan',
      url: 'https://testnet.bscscan.com',
    },
  ],
  blocks: {
    confirmations: 1,
    estimateBlockTime: 3,
    reorgPeriod: 9,
  },
  chainId: 97,
  displayName: 'BSC Testnet',
  domainId: 97,
  isTestnet: true,
  name: Chains.bsctestnet,
  nativeToken: bnbToken,
  protocol: ProtocolType.Ethereum,
  rpcUrls: [
    { http: 'https://bsc-testnet.publicnode.com' },
    { http: 'https://bsc-testnet.blockpi.network/v1/rpc/public' },
  ],
};

export const celo: ChainMetadata = {
  blockExplorers: [
    {
      apiUrl: 'https://api.celoscan.io/api',
      family: ExplorerFamily.Etherscan,
      name: 'CeloScan',
      url: 'https://celoscan.io',
    },
    {
      apiUrl: 'https://explorer.celo.org/mainnet/api',
      family: ExplorerFamily.Blockscout,
      name: 'Blockscout',
      url: 'https://explorer.celo.org',
    },
  ],
  blocks: {
    confirmations: 1,
    estimateBlockTime: 5,
    reorgPeriod: 0,
  },
  chainId: 42220,
  displayName: 'Celo',
  domainId: 42220,
  // The official Gnosis safe URL `https://safe-transaction-celo.safe.global` doesn't work well
  // with delegates on a multisig created with the old unofficial Celo tooling.
  gnosisSafeTransactionServiceUrl:
    'https://mainnet-tx-svc.celo-safe-prod.celo-networks-dev.org/',
  name: Chains.celo,
  nativeToken: celoToken,
  protocol: ProtocolType.Ethereum,
  rpcUrls: [{ http: 'https://forno.celo.org' }],
};

export const chiado: ChainMetadata = {
  blockExplorers: [
    {
      apiUrl: 'https://gnosis-chiado.blockscout.com/api',
      family: ExplorerFamily.Blockscout,
      name: 'GnosisScan',
      url: 'https://gnosis-chiado.blockscout.com',
    },
  ],
  blocks: {
    confirmations: 1,
    estimateBlockTime: 5,
    reorgPeriod: 14,
  },
  chainId: 10200,
  displayName: 'Chiado',
  domainId: 10200,
  isTestnet: true,
  name: Chains.chiado,
  nativeToken: xDaiToken,
  protocol: ProtocolType.Ethereum,
  rpcUrls: [{ http: 'https://gnosis-chiado.publicnode.com' }],
};

export const ethereum: ChainMetadata = {
  blockExplorers: [
    {
      apiUrl: 'https://api.etherscan.io/api',
      family: ExplorerFamily.Etherscan,
      name: 'Etherscan',
      url: 'https://etherscan.io',
    },
    {
      apiUrl: 'https://blockscout.com/eth/mainnet/api',
      family: ExplorerFamily.Blockscout,
      name: 'Blockscout',
      url: 'https://blockscout.com/eth/mainnet',
    },
  ],
  blocks: {
    confirmations: 7,
    estimateBlockTime: 13,
    reorgPeriod: 14,
  },
  chainId: 1,
  displayName: 'Ethereum',
  domainId: 1,
  gnosisSafeTransactionServiceUrl:
    'https://safe-transaction-mainnet.safe.global/',
  name: Chains.ethereum,
  nativeToken: etherToken,
  protocol: ProtocolType.Ethereum,
  rpcUrls: [
    { http: 'https://ethereum.publicnode.com' },
    { http: 'https://cloudflare-eth.com' },
  ],
};

export const fuji: ChainMetadata = {
  blockExplorers: [
    {
      apiUrl: 'https://api-testnet.snowtrace.io/api',
      family: ExplorerFamily.Etherscan,
      name: 'SnowTrace',
      url: 'https://testnet.snowtrace.io',
    },
  ],
  blocks: {
    confirmations: 3,
    estimateBlockTime: 2,
    reorgPeriod: 3,
  },
  chainId: 43113,
  displayName: 'Fuji',
  domainId: 43113,
  isTestnet: true,
  name: Chains.fuji,
  nativeToken: avaxToken,
  protocol: ProtocolType.Ethereum,
  rpcUrls: [
    {
      http: 'https://api.avax-test.network/ext/bc/C/rpc',
      pagination: { maxBlockRange: 2048 },
    },
  ],
};

export const goerli: ChainMetadata = {
  blockExplorers: [
    {
      apiUrl: 'https://api-goerli.etherscan.io/api',
      family: ExplorerFamily.Etherscan,
      name: 'Etherscan',
      url: 'https://goerli.etherscan.io',
    },
  ],
  blocks: {
    confirmations: 1,
    estimateBlockTime: 13,
    reorgPeriod: 2,
  },
  chainId: 5,
  displayName: 'Goerli',
  domainId: 5,
  isTestnet: true,
  name: Chains.goerli,
  nativeToken: etherToken,
  protocol: ProtocolType.Ethereum,
  rpcUrls: [
    { http: 'https://goerli.infura.io/v3/9aa3d95b3bc440fa88ea12eaa4456161' },
    { http: 'https://rpc.ankr.com/eth_goerli' },
  ],
};

export const gnosis: ChainMetadata = {
  blockExplorers: [
    {
      apiUrl: 'https://api.gnosisscan.io/api',
      family: ExplorerFamily.Etherscan,
      name: 'GnosisScan',
      url: 'https://gnosisscan.io',
    },
  ],
  blocks: {
    confirmations: 1,
    estimateBlockTime: 5,
    reorgPeriod: 14,
  },
  chainId: 100,
  displayName: 'Gnosis',
  domainId: 100,
  gasCurrencyCoinGeckoId: 'xdai',
  gnosisSafeTransactionServiceUrl:
    'https://safe-transaction-gnosis-chain.safe.global/',
  name: Chains.gnosis,
  nativeToken: xDaiToken,
  protocol: ProtocolType.Ethereum,
  rpcUrls: [
    {
      http: 'https://rpc.gnosischain.com',
      pagination: {
        maxBlockRange: 10000,
        minBlockNumber: 25997478,
      },
    },
  ],
};

export const lineagoerli: ChainMetadata = {
  blockExplorers: [
    {
      apiUrl: 'https://explorer.goerli.linea.build/api',
      family: ExplorerFamily.Blockscout,
      name: 'Linea Explorer',
      url: 'https://explorer.goerli.linea.build/',
    },
  ],
  blocks: {
    confirmations: 1,
    estimateBlockTime: 12,
    reorgPeriod: 2,
  },
  chainId: 59140,
  displayName: 'Linea Goerli',
  domainId: 59140,
  isTestnet: true,
  name: Chains.lineagoerli,
  nativeToken: etherToken,
  protocol: ProtocolType.Ethereum,
  rpcUrls: [{ http: 'https://rpc.goerli.linea.build' }],
};

export const mantapacific: ChainMetadata = {
  blockExplorers: [
    {
      apiUrl: 'https://pacific-explorer.manta.network/api',
      family: ExplorerFamily.Blockscout,
      name: 'Manta Pacific Explorer',
      url: 'https://pacific-explorer.manta.network',
    },
  ],
  blocks: {
    confirmations: 1,
    estimateBlockTime: 3,
    reorgPeriod: 1,
  },
  chainId: 169,
  displayName: 'Manta Pacific',
  displayNameShort: 'Manta',
  domainId: 169,
  isTestnet: false,
  name: Chains.mantapacific,
  nativeToken: {
    decimals: 18,
    name: 'Ether',
    symbol: 'ETH',
  },
  protocol: ProtocolType.Ethereum,
  rpcUrls: [{ http: 'https://pacific-rpc.manta.network/http' }],
};

export const moonbasealpha: ChainMetadata = {
  blockExplorers: [
    {
      apiUrl: 'https://api-moonbase.moonscan.io/api',
      family: ExplorerFamily.Etherscan,
      name: 'MoonScan',
      url: 'https://moonbase.moonscan.io',
    },
  ],
  blocks: {
    confirmations: 1,
    estimateBlockTime: 12,
    reorgPeriod: 1,
  },
  chainId: 1287,
  displayName: 'Moonbase Alpha',
  displayNameShort: 'Moonbase',
  domainId: 1287,
  isTestnet: true,
  name: Chains.moonbasealpha,
  nativeToken: {
    decimals: 18,
    name: 'DEV',
    symbol: 'DEV',
  },
  protocol: ProtocolType.Ethereum,
  rpcUrls: [{ http: 'https://rpc.api.moonbase.moonbeam.network' }],
};

export const moonbeam: ChainMetadata = {
  blockExplorers: [
    {
      apiUrl: 'https://api-moonbeam.moonscan.io/api',
      family: ExplorerFamily.Etherscan,
      name: 'MoonScan',
      url: 'https://moonscan.io',
    },
  ],
  blocks: {
    confirmations: 2,
    estimateBlockTime: 12,
    reorgPeriod: 2,
  },
  chainId: 1284,
  displayName: 'Moonbeam',
  domainId: 1284,
  gnosisSafeTransactionServiceUrl:
    'https://transaction.multisig.moonbeam.network',
  name: Chains.moonbeam,
  nativeToken: {
    decimals: 18,
    name: 'GLMR',
    symbol: 'GLMR',
  },
  protocol: ProtocolType.Ethereum,
  rpcUrls: [{ http: 'https://rpc.api.moonbeam.network' }],
};

export const mumbai: ChainMetadata = {
  blockExplorers: [
    {
      apiUrl: 'https://api-testnet.polygonscan.com/api',
      family: ExplorerFamily.Etherscan,
      name: 'PolygonScan',
      url: 'https://mumbai.polygonscan.com',
    },
  ],
  blocks: {
    confirmations: 3,
    estimateBlockTime: 5,
    reorgPeriod: 32,
  },
  chainId: 80001,
  displayName: 'Mumbai',
  domainId: 80001,
  isTestnet: true,
  name: Chains.mumbai,
  nativeToken: maticToken,
  protocol: ProtocolType.Ethereum,
  rpcUrls: [
    {
      http: 'https://rpc.ankr.com/polygon_mumbai',
      pagination: {
        // eth_getLogs and eth_newFilter are limited to a 10,000 blocks range
        maxBlockRange: 10000,
        minBlockNumber: 22900000,
      },
    },
  ],
};

export const nautilus: ChainMetadata = {
  blocks: {
    confirmations: 1,
    estimateBlockTime: 1,
    reorgPeriod: 1,
  },
  chainId: 22222,
  displayName: 'Nautilus',
  domainId: 22222,
  name: Chains.nautilus,
  nativeToken: {
    decimals: 18,
    name: 'Zebec',
    symbol: 'ZBC',
  },
  protocol: ProtocolType.Ethereum,
  rpcUrls: [
    {
      http: 'https://api.nautilus.nautchain.xyz',
    },
  ],
};

export const neutron: ChainMetadata = {
  bech32Prefix: 'neutron',
  blockExplorers: [
    {
      // TODO API not actually supported, using url to meet validation requirements
      apiUrl: 'https://www.mintscan.io/neutron',
      family: ExplorerFamily.Other,
      name: 'Mintscan',
      url: 'https://www.mintscan.io/neutron',
    },
  ],
  blocks: {
    confirmations: 1,
    estimateBlockTime: 3,
    reorgPeriod: 1,
  },
  chainId: 'neutron-1',
  displayName: 'Neutron',
  domainId: 1853125230,
  grpcUrls: [{ http: 'grpc-kralum.neutron-1.neutron.org:80' }],
  isTestnet: false,
  name: Chains.neutron,
  nativeToken: {
    decimals: 6,
    name: 'Neutron',
    symbol: 'NTRN',
  },
  protocol: ProtocolType.Cosmos,
  restUrls: [{ http: 'https://rest-lb.neutron.org' }],
  rpcUrls: [{ http: 'https://rpc-kralum.neutron-1.neutron.org' }],
  slip44: 118,
};

export const optimism: ChainMetadata = {
  blockExplorers: [
    {
      apiUrl: 'https://api-optimistic.etherscan.io/api',
      family: ExplorerFamily.Etherscan,
      name: 'Etherscan',
      url: 'https://optimistic.etherscan.io',
    },
  ],
  blocks: {
    confirmations: 1,
    estimateBlockTime: 3,
    reorgPeriod: 0,
  },
  chainId: 10,
  displayName: 'Optimism',
  domainId: 10,
  gasCurrencyCoinGeckoId: 'ethereum',
  // ETH is used for gas
  gnosisSafeTransactionServiceUrl:
    'https://safe-transaction-optimism.safe.global/',
  name: Chains.optimism,
  nativeToken: etherToken,
  protocol: ProtocolType.Ethereum,
  rpcUrls: [{ http: 'https://mainnet.optimism.io' }],
};

export const optimismgoerli: ChainMetadata = {
  blockExplorers: [
    {
      apiUrl: 'https://api-goerli-optimism.etherscan.io/api',
      family: ExplorerFamily.Etherscan,
      name: 'Etherscan',
      url: 'https://goerli-optimism.etherscan.io',
    },
  ],
  blocks: {
    confirmations: 1,
    estimateBlockTime: 3,
    reorgPeriod: 1,
  },
  chainId: 420,
  displayName: 'Optimism Goerli',
  displayNameShort: 'Opt. Goerli',
  domainId: 420,
  isTestnet: true,
  name: Chains.optimismgoerli,
  nativeToken: etherToken,
  protocol: ProtocolType.Ethereum,
  rpcUrls: [{ http: 'https://goerli.optimism.io' }],
};

export const polygon: ChainMetadata = {
  blockExplorers: [
    {
      apiUrl: 'https://api.polygonscan.com/api',
      family: ExplorerFamily.Etherscan,
      name: 'PolygonScan',
      url: 'https://polygonscan.com',
    },
  ],
  blocks: {
    confirmations: 200,
    estimateBlockTime: 2,
    reorgPeriod: 256,
  },
  chainId: 137,
  displayName: 'Polygon',
  domainId: 137,
  gasCurrencyCoinGeckoId: 'matic-network',
  gnosisSafeTransactionServiceUrl:
    'https://safe-transaction-polygon.safe.global/',
  name: Chains.polygon,
  nativeToken: etherToken,
  protocol: ProtocolType.Ethereum,
  rpcUrls: [
    {
      http: 'https://polygon-bor.publicnode.com',
    },
    { http: 'https://polygon-rpc.com' },
    { http: 'https://rpc.ankr.com/polygon' },
  ],
};

export const polygonzkevm: ChainMetadata = {
  blockExplorers: [
    {
      apiUrl: 'https://api-zkevm.polygonscan.com/api',
      family: ExplorerFamily.Etherscan,
      name: 'PolygonScan',
      url: 'https://zkevm.polygonscan.com',
    },
  ],
  // ETH is used for gas
  blocks: {
    confirmations: 1,
    estimateBlockTime: 10,
    reorgPeriod: 1,
  },
  chainId: 1101,
  displayName: 'Polygon zkEVM',
  displayNameShort: 'zkEVM',
  domainId: 1101,
  gasCurrencyCoinGeckoId: 'ethereum',
  name: Chains.polygonzkevm,
  nativeToken: etherToken,
  protocol: ProtocolType.Ethereum,
  rpcUrls: [
    { http: 'https://zkevm-rpc.com' },
    { http: 'https://polygonzkevm-mainnet.g.alchemy.com/v2/demo' },
    { http: 'https://rpc.ankr.com/polygon_zkevm' },
  ],
};

export const polygonzkevmtestnet: ChainMetadata = {
  blockExplorers: [
    {
      apiUrl: 'https://api-testnet-zkevm.polygonscan.com/api',
      family: ExplorerFamily.Etherscan,
      name: 'PolygonScan',
      url: 'https://testnet-zkevm.polygonscan.com',
    },
  ],
  blocks: {
    confirmations: 1,
    estimateBlockTime: 3,
    reorgPeriod: 1,
  },
  chainId: 1442,
  displayName: 'Polygon zkEVM Testnet',
  displayNameShort: 'ZkEvm Testnet',
  domainId: 1442,
  isTestnet: true,
  name: Chains.polygonzkevmtestnet,
  nativeToken: etherToken,
  protocol: ProtocolType.Ethereum,
  rpcUrls: [{ http: 'https://rpc.public.zkevm-test.net' }],
};

// Testnet for Nautilus
export const proteustestnet: ChainMetadata = {
  blocks: {
    confirmations: 1,
    estimateBlockTime: 1,
    reorgPeriod: 1,
  },
  chainId: 88002,
  displayName: 'Proteus Testnet',
  domainId: 88002,
  name: Chains.proteustestnet,
  nativeToken: {
    decimals: 18,
    name: 'Zebec',
    symbol: 'ZBC',
  },
  protocol: ProtocolType.Ethereum,
  rpcUrls: [
    {
      http: 'https://api.proteus.nautchain.xyz/solana',
    },
  ],
};

export const scroll: ChainMetadata = {
  blockExplorers: [
    {
      apiUrl: 'https://api.scrollscan.com/api',
      family: ExplorerFamily.Etherscan,
      name: 'Scroll Explorer',
      url: 'https://scrollscan.com/',
    },
  ],
  // ETH is used for gas
  blocks: {
    confirmations: 1,
    estimateBlockTime: 3,
    reorgPeriod: 1,
  },
  chainId: 534352,
  displayName: 'Scroll',
  domainId: 534352,
  gasCurrencyCoinGeckoId: 'ethereum',
  name: Chains.scroll,
  nativeToken: etherToken,
  protocol: ProtocolType.Ethereum,
  rpcUrls: [{ http: 'https://scroll.blockpi.network/v1/rpc/public' }],
};

export const scrollsepolia: ChainMetadata = {
  blockExplorers: [
    {
      apiUrl: 'https://api-sepolia.scrollscan.com/api',
      family: ExplorerFamily.Etherscan,
      name: 'Scroll Explorer',
      url: 'https://sepolia.scrollscan.dev/',
    },
  ],
  blocks: {
    confirmations: 1,
    estimateBlockTime: 3,
    reorgPeriod: 1,
  },
  chainId: 534351,
  displayName: 'Scroll Sepolia',
  domainId: 534351,
  isTestnet: true,
  name: Chains.scrollsepolia,
  nativeToken: etherToken,
  protocol: ProtocolType.Ethereum,
  rpcUrls: [{ http: 'https://sepolia-rpc.scroll.io' }],
};

export const sepolia: ChainMetadata = {
  blockExplorers: [
    {
      apiUrl: 'https://api-sepolia.etherscan.io/api',
      family: ExplorerFamily.Etherscan,
      name: 'Etherscan',
      url: 'https://sepolia.etherscan.io',
    },
  ],
  blocks: {
    confirmations: 1,
    estimateBlockTime: 13,
    reorgPeriod: 2,
  },
  chainId: 11155111,
  displayName: 'Sepolia',
  domainId: 11155111,
  isTestnet: true,
  name: Chains.sepolia,
  nativeToken: etherToken,
  protocol: ProtocolType.Ethereum,
  rpcUrls: [
    { http: 'https://ethereum-sepolia.blockpi.network/v1/rpc/public' },
    { http: 'https://rpc.sepolia.org' },
  ],
};

export const solana: ChainMetadata = {
  blockExplorers: [
    {
      apiUrl: 'https://explorer.solana.com',
      family: ExplorerFamily.Other,
      name: 'Solana Explorer',
      url: 'https://explorer.solana.com',
    },
  ],

  blocks: {
    confirmations: 1,
    estimateBlockTime: 0.4,
    reorgPeriod: 0,
  },
  // Uses the same ChainId as https://www.alchemy.com/chain-connect/chain/solana
  chainId: 1399811149,
  displayName: 'Solana',
  domainId: 1399811149,
  name: 'solana',
  nativeToken: solToken,
  protocol: ProtocolType.Sealevel,
  rpcUrls: [{ http: 'https://api.mainnet-beta.solana.com' }],
};

export const solanatestnet: ChainMetadata = {
  blockExplorers: [
    {
      apiUrl: 'https://explorer.solana.com',
      family: ExplorerFamily.Other,
      name: 'Solana Explorer',
      url: 'https://explorer.solana.com',
    },
  ],
  blocks: {
    confirmations: 1,
    estimateBlockTime: 0.4,
    reorgPeriod: 0,
  },
  chainId: 1399811150,
  displayName: 'Solana Testnet',
  displayNameShort: 'Sol Testnet',
  domainId: 1399811150,
  isTestnet: true,
  name: 'solanatestnet',
  nativeToken: solToken,
  protocol: ProtocolType.Sealevel,
  rpcUrls: [{ http: 'https://api.testnet.solana.com' }],
};

export const solanadevnet: ChainMetadata = {
  blockExplorers: [
    {
      apiUrl: 'https://explorer.solana.com',
      family: ExplorerFamily.Other,
      name: 'Solana Explorer',
      url: 'https://explorer.solana.com',
    },
  ],
  blocks: {
    confirmations: 1,
    estimateBlockTime: 0.4,
    reorgPeriod: 0,
  },
  chainId: 1399811151,
  displayName: 'Solana Devnet',
  displayNameShort: 'Sol Devnet',
  domainId: 1399811151,
  isTestnet: true,
  name: 'solanadevnet',
  nativeToken: solToken,
  protocol: ProtocolType.Sealevel,
  rpcUrls: [{ http: 'https://api.devnet.solana.com' }],
};

export const eclipsetestnet: ChainMetadata = {
  blockExplorers: [
    {
      apiUrl: 'https://testnet.dev2.eclipsenetwork.xyz',
      family: ExplorerFamily.Other,
      name: 'Eclipse Testnet Explorer',
      url: 'https://explorer.dev.eclipsenetwork.xyz/?cluster=testnet',
    },
  ],
  blocks: {
    confirmations: 1,
    estimateBlockTime: 0.4,
    reorgPeriod: 0,
  },
  chainId: 239092742,
  displayName: 'Eclipse Testnet',
  domainId: 239092742,
  isTestnet: true,
  name: 'eclipsetestnet',
  nativeToken: {
    ...etherToken,
    decimals: 9,
  },
  protocol: ProtocolType.Sealevel,
  rpcUrls: [{ http: 'https://testnet.dev2.eclipsenetwork.xyz' }],
};

export const test1: ChainMetadata = {
  blockExplorers: [],
  blocks: {
    confirmations: 1,
    estimateBlockTime: 3,
    reorgPeriod: 0,
  },
  chainId: 13371,
  displayName: 'Test 1',
  domainId: 13371,
  isTestnet: true,
  name: Chains.test1,
  nativeToken: etherToken,
  protocol: ProtocolType.Ethereum,
  rpcUrls: [{ http: 'http://127.0.0.1:8545' }],
};

export const test2: ChainMetadata = {
  blockExplorers: [],
  blocks: {
    confirmations: 1,
    estimateBlockTime: 3,
    reorgPeriod: 1,
  },
  chainId: 13372,
  displayName: 'Test 2',
  domainId: 13372,
  isTestnet: true,
  name: Chains.test2,
  nativeToken: etherToken,
  protocol: ProtocolType.Ethereum,
  rpcUrls: [{ http: 'http://127.0.0.1:8545' }],
};

export const test3: ChainMetadata = {
  blockExplorers: [],
  blocks: {
    confirmations: 1,
    estimateBlockTime: 3,
    reorgPeriod: 2,
  },
  chainId: 13373,
  displayName: 'Test 3',
  domainId: 13373,
  isTestnet: true,
  name: Chains.test3,
  nativeToken: etherToken,
  protocol: ProtocolType.Ethereum,
  rpcUrls: [{ http: 'http://127.0.0.1:8545' }],
};

export const viction: ChainMetadata = {
  blockExplorers: [
    {
      apiUrl: 'https://www.vicscan.xyz/api',
      family: ExplorerFamily.Other,
      name: 'Vicscan',
      url: 'https://www.vicscan.xyz/',
    },
  ],
  blocks: {
    confirmations: 1,
    estimateBlockTime: 2,
    reorgPeriod: 0,
  },
  chainId: 88,
  displayName: 'Viction',
  domainId: 88,
  name: Chains.viction,
  nativeToken: {
    decimals: 18,
    name: 'Viction',
    symbol: 'VIC',
  },
  protocol: ProtocolType.Ethereum,
  rpcUrls: [
    {
      http: 'https://viction.blockpi.network/v1/rpc/public',
    },
  ],
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
  base,
  basegoerli,
  bsc,
  bsctestnet,
  celo,
  chiado,
  eclipsetestnet,
  ethereum,
  fuji,
  gnosis,
  goerli,
  lineagoerli,
  mantapacific,
  moonbasealpha,
  moonbeam,
  mumbai,
  nautilus,
  neutron,
  optimism,
  optimismgoerli,
  polygon,
  polygonzkevm,
  polygonzkevmtestnet,
  proteustestnet,
  scroll,
  scrollsepolia,
  sepolia,
  solana,
  solanadevnet,
  solanatestnet,
  test1,
  test2,
  test3,
  viction,
};

export const chainIdToMetadata = Object.values(chainMetadata).reduce<
  Record<string | number, ChainMetadata>
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
  solanadevnet: 'devnet',
  solanatestnet: 'testnet',
};
