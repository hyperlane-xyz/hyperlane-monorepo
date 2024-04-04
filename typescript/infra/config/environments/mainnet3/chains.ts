import {
  ChainMap,
  ChainMetadata,
  Mainnets,
  chainMetadata,
} from '@hyperlane-xyz/sdk';

import { getChainMetadatas } from '../../../src/config/chain.js';

// The `Mainnets` from the SDK are all supported chains for the mainnet3 environment.
// These chains may be any protocol type.
export const supportedChainNames = Mainnets;

export type MainnetChains = (typeof supportedChainNames)[number];
export const environment = 'mainnet3';

const {
  ethereumMetadatas: defaultEthereumMainnetConfigs,
  nonEthereumMetadatas: nonEthereumMainnetConfigs,
} = getChainMetadatas(supportedChainNames);

export const ethereumMainnetConfigs: ChainMap<ChainMetadata> = {
  ...defaultEthereumMainnetConfigs,
  bsc: {
    ...chainMetadata.bsc,
    transactionOverrides: {
      gasPrice: 7 * 10 ** 9, // 7 gwei
    },
  },
  polygon: {
    ...chainMetadata.polygon,
    blocks: {
      ...chainMetadata.polygon.blocks,
      confirmations: 3,
    },
    transactionOverrides: {
      maxFeePerGas: 250 * 10 ** 9, // 250 gwei
      maxPriorityFeePerGas: 50 * 10 ** 9, // 50 gwei
      // gasPrice: 50 * 10 ** 9, // 50 gwei
    },
  },
  ethereum: {
    ...chainMetadata.ethereum,
    blocks: {
      ...chainMetadata.ethereum.blocks,
      confirmations: 3,
    },
    transactionOverrides: {
      maxFeePerGas: 150 * 10 ** 9, // gwei
      maxPriorityFeePerGas: 5 * 10 ** 9, // gwei
    },
  },
};

export const mainnetConfigs: ChainMap<ChainMetadata> = {
  ...ethereumMainnetConfigs,
  ...nonEthereumMainnetConfigs,
};

export const ethereumChainNames = Object.keys(
  ethereumMainnetConfigs,
) as MainnetChains[];
