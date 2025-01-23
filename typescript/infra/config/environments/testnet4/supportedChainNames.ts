// Placing them here instead of adjacent chains file to avoid circular dep
export const testnet4SupportedChainNames = [
  'abstracttestnet',
  'alephzeroevmtestnet',
  'alfajores',
  'arbitrumsepolia',
  'arcadiatestnet2',
  'basesepolia',
  'berabartio',
  'bsctestnet',
  'camptestnet',
  'citreatestnet',
  'connextsepolia',
  'ecotestnet',
  'eclipsetestnet',
  'flametestnet',
  'formtestnet',
  'fuji',
  'holesky',
  'hyperliquidevmtestnet',
  'inksepolia',
  'odysseytestnet',
  'optimismsepolia',
  // Disabling plumetestnet on Sept 16, 2024: chain is paused for "airplane mode"
  // 'plumetestnet',
  'polygonamoy',
  'scrollsepolia',
  'sepolia',
  'solanatestnet',
  'soneiumtestnet',
  'sonicblaze',
  'sonicsvmtestnet',
  'suavetoliman',
  'superpositiontestnet',
  'treasuretopaz',
  'unichaintestnet',
] as const;

export const supportedChainNames = [...testnet4SupportedChainNames];
