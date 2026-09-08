// Placing them here instead of adjacent chains file to avoid circular dep
export const testnet4SupportedChainNames = [
  'aleotestnet',
  'arbitrumsepolia',
  'basesepolia',
  'bsctestnet',
  'hyperliquidevmtestnet',
  'optimismsepolia',
  'polygonamoy',
  'seismictestnet',
  'sepolia',
  'solanadevnet',
  'solanatestnet',
  'somniatestnet',
  'tronshasta',
] as const;

export const supportedChainNames = [...testnet4SupportedChainNames];
