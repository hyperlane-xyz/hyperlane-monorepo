// Placing them here instead of adjacent chains file to avoid circular dep
export const testnet4SupportedChainNames = [
  'alfajores',
  'bsctestnet',
  'connextsepolia',
  'eclipsetestnet',
  'holesky',
  'fuji',
  'plumetestnet',
  'scrollsepolia',
  'sepolia',
  'solanatestnet',
  'superpositiontestnet',
] as const;

export const supportedChainNames = [...testnet4SupportedChainNames];
