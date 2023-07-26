import { ChainMap } from '@hyperlane-xyz/sdk';

// TODO move to SDK
export const startBlocks: ChainMap<number> = {
  // --------------- Mainnets ---------------------
  celo: 16884144,
  ethereum: 16271503,
  avalanche: 24145479,
  polygon: 37313389,
  bsc: 25063295,
  arbitrum: 49073182,
  optimism: 55698988,
  moonbeam: 2595747,
  gnosis: 25900000,
  // --------------- Testnets ---------------------
  alfajores: 14863532,
  fuji: 16330615,
  mumbai: 29390033,
  bsctestnet: 25001629,
  goerli: 8039005,
  sepolia: 3082913,
  moonbasealpha: 3310405,
  optimismgoerli: 3055263,
  arbitrumgoerli: 1941997,
};
