import { ChainMap, ChainMetadata } from '@hyperlane-xyz/sdk';
import { objKeys } from '@hyperlane-xyz/utils';

import { getChainMetadatas } from '../../../src/config/chain.js';
import { getChain } from '../../registry.js';

import { supportedChainNames } from './supportedChainNames.js';

export const environment = 'testnet4';

const { ethereumMetadatas: defaultEthereumMainnetConfigs } =
  getChainMetadatas(supportedChainNames);

export const testnetConfigs: ChainMap<ChainMetadata> = {
  ...defaultEthereumMainnetConfigs,
  bsctestnet: {
    ...getChain('bsctestnet'),
    transactionOverrides: {
      gasPrice: 8 * 10 ** 9, // 8 gwei
    },
  },
};

export const ethereumChainNames = objKeys(defaultEthereumMainnetConfigs);
