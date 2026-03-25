import { ChainMetadata, chainMetadata } from '@hyperlane-xyz/sdk';

export const tronChainMetadata: ChainMetadata = {
  ...chainMetadata.tron,
  // Tron-specific configuration
  blockExplorers: [
    {
      name: 'Tronscan',
      url: 'https://tronscan.org',
      apiUrl: 'https://api.tronscan.org/api',
    },
  ],
  blocks: {
    confirmations: 1,
    reorgPeriod: 1,
    estimateBlockTime: 3, // Tron blocks are 3 seconds
  },
  // Tron uses TRX as native token
  nativeToken: {
    name: 'TRON',
    symbol: 'TRX',
    decimals: 6,
  },
  // Tron-specific RPC configuration
  rpcUrls: [
    {
      http: 'https://api.trongrid.io',
    },
  ],
  // Tron transaction configuration
  transactionOverrides: {
    // Tron has different fee structure
    // feeLimit is in SUN (1 TRX = 1,000,000 SUN)
    feeLimit: 10000000, // 10 TRX
  },
};

// Tron mainnet configuration
export const tronMainnetConfig = {
  ...tronChainMetadata,
  chainId: 728126428, // Tron mainnet chain ID
  domainId: 728126428, // Same as chainId for Tron
  name: 'tron',
  displayName: 'Tron',
  protocol: 'tron' as const,
};

// Tron testnet configuration
export const tronTestnetConfig = {
  ...tronChainMetadata,
  chainId: 2494104990, // Tron testnet chain ID
  domainId: 2494104990, // Same as chainId for Tron testnet
  name: 'tron_testnet',
  displayName: 'Tron Testnet',
  protocol: 'tron' as const,
};
