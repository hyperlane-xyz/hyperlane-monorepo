import { ChainMap, ChainMetadata, chainMetadata } from '@hyperlane-xyz/sdk';

import { AgentChainNames, Role } from '../../../src/roles';

export const ethereumMainnetConfigs: ChainMap<ChainMetadata> = {
  bsc: {
    ...chainMetadata.bsc,
    transactionOverrides: {
      gasPrice: 7 * 10 ** 9, // 7 gwei
    },
  },
  avalanche: chainMetadata.avalanche,
  polygon: {
    ...chainMetadata.polygon,
    blocks: {
      ...chainMetadata.polygon.blocks,
      confirmations: 3,
    },
    transactionOverrides: {
      maxFeePerGas: 500 * 10 ** 9, // 500 gwei
      maxPriorityFeePerGas: 100 * 10 ** 9, // 100 gwei
      // gasPrice: 50 * 10 ** 9, // 50 gwei
    },
  },
  celo: chainMetadata.celo,
  arbitrum: chainMetadata.arbitrum,
  optimism: chainMetadata.optimism,
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
  moonbeam: chainMetadata.moonbeam,
  gnosis: chainMetadata.gnosis,
};

// Blessed non-Ethereum chains.
export const nonEthereumMainnetConfigs: ChainMap<ChainMetadata> = {
  solana: chainMetadata.solana,
};

export const mainnetConfigs: ChainMap<ChainMetadata> = {
  ...ethereumMainnetConfigs,
  ...nonEthereumMainnetConfigs,
};

export type MainnetChains = keyof typeof mainnetConfigs;
export const supportedChainNames = Object.keys(
  mainnetConfigs,
) as MainnetChains[];
export const environment = 'mainnet2';

export const ethereumChainNames = Object.keys(
  ethereumMainnetConfigs,
) as MainnetChains[];

const validatorChainNames = [
  ...supportedChainNames,
  chainMetadata.solana.name,
  chainMetadata.nautilus.name,
];

const relayerChainNames = validatorChainNames;

export const agentChainNames: AgentChainNames = {
  [Role.Validator]: validatorChainNames,
  [Role.Relayer]: relayerChainNames,
  [Role.Scraper]: ethereumChainNames,
};
