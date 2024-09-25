// Placing them here instead of adjacent chains file to avoid circular dep
export const testnet4SupportedChainNames = [
  'alfajores',
  'arbitrumsepolia',
  'basesepolia',
  'berabartio',
  'bsctestnet',
  'citreatestnet',
  'connextsepolia',
  'ecotestnet',
  'eclipsetestnet',
  'fuji',
  'holesky',
  'hyperliquidevmtestnet',
  'mevmdevnet',
  'optimismsepolia',
  // Disabling plumetestnet on Sept 16, 2024: chain is paused for "airplane mode"
  // 'plumetestnet',
  'polygonamoy',
  'scrollsepolia',
  'sepolia',
  'solanatestnet',
  'superpositiontestnet',
] as const;

export const supportedChainNames = [...testnet4SupportedChainNames];
