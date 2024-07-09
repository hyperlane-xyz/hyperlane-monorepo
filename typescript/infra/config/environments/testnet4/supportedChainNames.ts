// Placing them here instead of adjacent chains file to avoid circular dep
export const testnet4SupportedChainNames = [
  'alfajores',
  'bsctestnet',
  'eclipsetestnet',
  'holesky',
  'fuji',
  'plumetestnet',
  'scrollsepolia',
  'sepolia',
  'solanatestnet',
] as const;

export const supportedChainNames = [...testnet4SupportedChainNames];
