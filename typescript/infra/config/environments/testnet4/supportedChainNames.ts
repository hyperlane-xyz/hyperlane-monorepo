// Placing them here instead of adjacent chains file to avoid circular dep
export const testnet4SupportedChainNames = [
  'alfajores',
  'arbitrumsepolia',
  'basesepolia',
  'bsctestnet',
  'connextsepolia',
  'ecotestnet',
  'eclipsetestnet',
  'fuji',
  'holesky',
  'optimismsepolia',
  'plumetestnet',
  'polygonamoy',
  'scrollsepolia',
  'sepolia',
  'solanatestnet',
  'superpositiontestnet',
] as const;

export const supportedChainNames = [...testnet4SupportedChainNames];
