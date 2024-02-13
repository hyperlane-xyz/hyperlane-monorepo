import {
  ChainMap,
  ChainMetadata,
  Chains,
  Mainnets,
  chainMetadata,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { AgentChainNames, Role } from '../../../src/roles';

const defaultEthereumMainnetConfigs = Object.fromEntries(
  Mainnets.map((chain) => chainMetadata[chain])
    .filter((metadata) => metadata.protocol === ProtocolType.Ethereum)
    .map((metadata) => [metadata.name, metadata]),
);

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

// Blessed non-Ethereum chains.
export const nonEthereumMainnetConfigs: ChainMap<ChainMetadata> = {
  // solana: chainMetadata.solana,
  // neutron: chainMetadata.neutron,
  injective: chainMetadata.injective,
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

// Remove mantapacific, as it's not considered a "blessed"
// chain and we don't relay to mantapacific on the Hyperlane or RC contexts.
const relayerHyperlaneContextChains = supportedChainNames.filter(
  (chainName) => chainName !== Chains.mantapacific,
);

// Ethereum chains only.
const scraperHyperlaneContextChains = ethereumChainNames.filter(
  // Has RPC non-compliance that breaks scraping.
  (chainName) => chainName !== Chains.viction,
);

// Hyperlane & RC context agent chain names.
export const agentChainNames: AgentChainNames = {
  // Run validators for all chains.
  [Role.Validator]: supportedChainNames,
  [Role.Relayer]: relayerHyperlaneContextChains,
  [Role.Scraper]: scraperHyperlaneContextChains,
};
