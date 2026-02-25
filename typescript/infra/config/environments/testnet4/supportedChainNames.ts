// Placing them here instead of adjacent chains file to avoid circular dep
export const testnet4SupportedChainNames = [
  'aleotestnet',
  'arbitrumsepolia',
  'arcadiatestnet2',
  'basesepolia',
  'bsctestnet',
  'celestiatestnet',
  'celosepolia',
  'cotitestnet',
  'eclipsetestnet',
  'fuji',
  'hyperliquidevmtestnet',
  'incentivtestnet',
  'kyvetestnet',
  'modetestnet',
  'optimismsepolia',
  'paradexsepolia',
  'polygonamoy',
  'radixtestnet',
  'sepolia',
  'solanatestnet',
  'somniatestnet',
  'sonicsvmtestnet',
  'starknetsepolia',
] as const;

export const supportedChainNames = [...testnet4SupportedChainNames];
