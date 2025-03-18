// Placing them here instead of adjacent chains file to avoid circular dep
export const testnet4SupportedChainNames = [
  'abstracttestnet',
  'alephzeroevmtestnet',
  'alfajores',
  'arbitrumsepolia',
  'arcadiatestnet2',
  'basesepolia',
  'bsctestnet',
  'camptestnet',
  'carrchaintestnet',
  'chronicleyellowstone',
  'citreatestnet',
  'connextsepolia',
  'ecotestnet',
  'eclipsetestnet',
  'flametestnet',
  'formtestnet',
  'fuji',
  'holesky',
  'hyperliquidevmtestnet',
  'infinityvmmonza',
  'inksepolia',
  'monadtestnet',
  'odysseytestnet',
  'optimismsepolia',
  // Disabling plumetestnet on Sept 16, 2024: chain is paused for "airplane mode"
  // 'plumetestnet',
  'polygonamoy',
  'rometestnet',
  'scrollsepolia',
  'sepolia',
  'solanatestnet',
  'somniatestnet',
  'soneiumtestnet',
  'sonicblaze',
  'sonicsvmtestnet',
  'suavetoliman',
  'subtensortestnet',
  'superpositiontestnet',
  'treasuretopaz',
  'unichaintestnet',
  'weavevmtestnet',
] as const;

export const supportedChainNames = [...testnet4SupportedChainNames];
