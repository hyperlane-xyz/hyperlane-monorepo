// Placing them here instead of adjacent chains file to avoid circular dep
export const testnet4SupportedChainNames = [
  'alfajores',
  'arbitrumsepolia',
  'basesepolia',
  'berabartio',
  'bsctestnet',
  'camptestnet',
  'citreatestnet',
  'connextsepolia',
  'ecotestnet',
  'eclipsetestnet',
  'formtestnet',
  'fuji',
  'holesky',
  // 'hyperliquidevmtestnet',
  'optimismsepolia',
  // Disabling plumetestnet on Sept 16, 2024: chain is paused for "airplane mode"
  // 'plumetestnet',
  'polygonamoy',
  'scrollsepolia',
  'sepolia',
  'solanatestnet',
  'soneiumtestnet',
  'suavetoliman',
  'superpositiontestnet',
] as const;

export const supportedChainNames = [...testnet4SupportedChainNames];
