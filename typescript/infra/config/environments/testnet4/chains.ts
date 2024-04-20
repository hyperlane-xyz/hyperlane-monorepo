import { ChainMap, ChainMetadata } from '@hyperlane-xyz/sdk';

import { getChain } from '../../registry.js';

// All supported chains for the testnet4 environment.
// These chains may be any protocol type.
export const supportedChainNames = [
  'alfajores',
  'bsctestnet',
  'eclipsetestnet',
  'fuji',
  'plumetestnet',
  'scrollsepolia',
  'sepolia',
  'solanatestnet',
];

export const environment = 'testnet4';

export const testnetConfigs: ChainMap<ChainMetadata> = {
  ...Object.fromEntries(
    supportedChainNames.map((chain) => [chain, getChain(chain)]),
  ),
  bsctestnet: {
    ...getChain('bsctestnet'),
    transactionOverrides: {
      gasPrice: 8 * 10 ** 9, // 8 gwei
    },
  },
};
