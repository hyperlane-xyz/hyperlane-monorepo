import { ChainMap, ChainMetadata, chainMetadata } from '@hyperlane-xyz/sdk';

import { ALL_AGENT_ROLES, AgentChainNames, Role } from '../../../src/roles';

export const testnetConfigs: ChainMap<ChainMetadata> = {
  alfajores: chainMetadata.alfajores,
  fuji: chainMetadata.fuji,
  mumbai: {
    ...chainMetadata.mumbai,
    transactionOverrides: {
      maxFeePerGas: 70 * 10 ** 9, // 70 gwei
      maxPriorityFeePerGas: 40 * 10 ** 9, // 40 gwei
    },
  },
  bsctestnet: chainMetadata.bsctestnet,
  goerli: chainMetadata.goerli,
  sepolia: chainMetadata.sepolia,
  moonbasealpha: chainMetadata.moonbasealpha,
  optimismgoerli: chainMetadata.optimismgoerli,
  arbitrumgoerli: chainMetadata.arbitrumgoerli,
};

// "Blessed" chains that we want core contracts for.
export type TestnetChains = keyof typeof testnetConfigs;
export const supportedChainNames = Object.keys(
  testnetConfigs,
) as TestnetChains[];
export const environment = 'testnet3';

const validatorChainNames = [
  ...supportedChainNames,
  'solanadevnet',
  'proteustestnet',
];

const relayerChainNames = validatorChainNames;

export const agentChainNames: AgentChainNames = {
  [Role.Validator]: validatorChainNames,
  [Role.Relayer]: relayerChainNames,
  [Role.Scraper]: supportedChainNames,
};
