import {
  ChainMap,
  ChainMetadata,
  ChainName,
  Chains,
  CoreChainName,
  Mainnets,
  chainMetadata,
} from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

import {
  AgentChainConfig,
  getAgentChainNamesFromConfig,
} from '../../../src/config';
import { getChainMetadatas } from '../../../src/config/chain';
import { AgentChainNames, AgentRole, Role } from '../../../src/roles';

const {
  ethereumMetadatas: defaultEthereumMainnetConfigs,
  nonEthereumMetadatas: nonEthereumMainnetConfigs,
} = getChainMetadatas(Mainnets);

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

export type MainnetChains = keyof typeof mainnetConfigs;
export const supportedChainNames = Object.keys(
  mainnetConfigs,
) as MainnetChains[];
export const environment = 'mainnet3';

export const ethereumChainNames = Object.keys(
  ethereumMainnetConfigs,
) as MainnetChains[];
