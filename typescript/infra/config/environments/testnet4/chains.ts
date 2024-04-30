import { ChainMap, ChainMetadata } from '@hyperlane-xyz/sdk';

import { getChain } from '../../registry.js';

import { supportedChainNames } from './supportedChainNames.js';

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
