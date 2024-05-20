import { ChainMap, ChainMetadata } from '@hyperlane-xyz/sdk';
import { objKeys } from '@hyperlane-xyz/utils';

import { getChainMetadatas } from '../../../src/config/chain.js';
import { getChain } from '../../registry.js';

import { supportedChainNames } from './supportedChainNames.js';

export const environment = 'mainnet3';

const {
  ethereumMetadatas: defaultEthereumMainnetConfigs,
  nonEthereumMetadatas: nonEthereumMainnetConfigs,
} = getChainMetadatas(supportedChainNames);

export const ethereumMainnetConfigs: ChainMap<ChainMetadata> = {
  ...defaultEthereumMainnetConfigs,
  bsc: {
    ...(getChain('bsc') as ChainMetadata),
    transactionOverrides: {
      gasPrice: 3 * 10 ** 9, // 3 gwei
    },
  },
  polygon: {
    ...(getChain('polygon') as ChainMetadata),
    blocks: {
      ...(getChain('polygon') as ChainMetadata).blocks,
      confirmations: 3,
    },
    transactionOverrides: {
      // A very high max fee per gas is used as Polygon is susceptible
      // to large swings in gas prices.
      maxFeePerGas: 800 * 10 ** 9, // 800 gwei
      maxPriorityFeePerGas: 50 * 10 ** 9, // 50 gwei
    },
  },
  ethereum: {
    ...(getChain('ethereum') as ChainMetadata),
    blocks: {
      ...(getChain('ethereum') as ChainMetadata).blocks,
      confirmations: 3,
    },
    transactionOverrides: {
      maxFeePerGas: 150 * 10 ** 9, // gwei
      maxPriorityFeePerGas: 5 * 10 ** 9, // gwei
    },
  },
  scroll: {
    ...(getChain('scroll') as ChainMetadata),
    transactionOverrides: {
      // Scroll doesn't use EIP 1559 and the gas price that's returned is sometimes
      // too low for the transaction to be included in a reasonable amount of time -
      // this often leads to transaction underpriced issues.
      gasPrice: 2 * 10 ** 9, // 2 gwei
    },
  },
  moonbeam: {
    ...(getChain('moonbeam') as ChainMetadata),
    transactionOverrides: {
      maxFeePerGas: 350 * 10 ** 9, // 350 gwei
      maxPriorityFeePerGas: 50 * 10 ** 9, // 50 gwei
    },
  },
};

export const mainnetConfigs: ChainMap<ChainMetadata> = {
  ...ethereumMainnetConfigs,
  ...nonEthereumMainnetConfigs,
};

export const ethereumChainNames = objKeys(ethereumMainnetConfigs);
