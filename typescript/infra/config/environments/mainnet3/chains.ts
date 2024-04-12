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
      gasPrice: 3 * 10 ** 9, // 3 gwei
    },
  },
  polygon: {
    ...chainMetadata.polygon,
    blocks: {
      ...chainMetadata.polygon.blocks,
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
  scroll: {
    ...chainMetadata.scroll,
    transactionOverrides: {
      // Scroll doesn't use EIP 1559 and the gas price that's returned is sometimes
      // too low for the transaction to be included in a reasonable amount of time -
      // this often leads to transaction underpriced issues.
      gasPrice: 2 * 10 ** 9, // 2 gwei
    },
  },
  moonbeam: {
    ...chainMetadata.moonbeam,
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

export const ethereumChainNames = Object.keys(
  ethereumMainnetConfigs,
) as MainnetChains[];
