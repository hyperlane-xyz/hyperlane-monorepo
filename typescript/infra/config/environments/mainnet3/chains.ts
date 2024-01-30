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
      maxFeePerGas: 1000 * 10 ** 9, // 500 gwei
      maxPriorityFeePerGas: 200 * 10 ** 9, // 100 gwei
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
  solana: chainMetadata.solana,
  neutron: chainMetadata.neutron,
};

export const mainnetConfigs: ChainMap<ChainMetadata> = {
  ...ethereumMainnetConfigs,
  // ...nonEthereumMainnetConfigs,
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
// chain - we don't relay to mantapacific on the Hyperlane or RC contexts.
const hyperlaneContextRelayChains = ethereumChainNames.filter(
  (chainName) => chainName !== Chains.mantapacific,
);

// Skip viction, as it returns incorrect block hashes for eth_getLogs RPCs,
// which breaks the scraper.
const scraperChains = ethereumChainNames.filter(
  (chainName) => chainName !== Chains.viction,
);

// Hyperlane & RC context agent chain names.
export const agentChainNames: AgentChainNames = {
  // Run validators for all chains.
  [Role.Validator]: supportedChainNames,
  [Role.Relayer]: hyperlaneContextRelayChains,
  [Role.Scraper]: scraperChains,
};
