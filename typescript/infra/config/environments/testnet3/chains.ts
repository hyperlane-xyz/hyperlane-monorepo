import { ChainMap, ChainMetadata, chainMetadata } from '@hyperlane-xyz/sdk';

import { ALL_AGENT_ROLES, Role } from '../../../src/roles';

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

export type AgentRoles = typeof ALL_AGENT_ROLES;
export type AgentChainNames = Map<ALL_AGENT_ROLES, string[]>;
export const agentChainNames: AgentChainNames = new Map([
  [Role.Validator, validatorChainNames],
  [Role.Relayer, relayerChainNames],
  [Role.Scraper, supportedChainNames],
]);
