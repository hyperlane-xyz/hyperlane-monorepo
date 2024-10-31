// Placing them here instead of adjacent chains file to avoid circular dep
export const testnet4SupportedChainNames = [
  'alfajores',
  'arbitrumsepolia',
  // Disabling arcadiatestnet on Oct 29, 2024: chain reset and needs to be redeployed
  // 'arcadiatestnet',
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
  'odysseytestnet',
  'optimismsepolia',
  // Disabling plumetestnet on Sept 16, 2024: chain is paused for "airplane mode"
  // 'plumetestnet',
  'polygonamoy',
  'scrollsepolia',
  'sepolia',
  'solanatestnet',
  'soneiumtestnet',
  'sonictestnet',
  'suavetoliman',
  'superpositiontestnet',
  'unichaintestnet',
] as const;

export const supportedChainNames = [...testnet4SupportedChainNames];
