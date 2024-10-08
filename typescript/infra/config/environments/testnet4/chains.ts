import { ChainMap, ChainMetadata } from '@hyperlane-xyz/sdk';

import { isEthereumProtocolChain } from '../../../src/utils/utils.js';

import { supportedChainNames } from './supportedChainNames.js';

export const environment = 'testnet4';

export const ethereumChainNames = supportedChainNames.filter(
  isEthereumProtocolChain,
);

export const chainMetadataOverrides: ChainMap<Partial<ChainMetadata>> = {
  bsctestnet: {
    transactionOverrides: {
      gasPrice: 8 * 10 ** 9, // 8 gwei
    },
  },
  scrollsepolia: {
    transactionOverrides: {
      gasPrice: 5 * 10 ** 8, // 0.5 gwei
    },
  },
};
