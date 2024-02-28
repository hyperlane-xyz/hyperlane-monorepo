import {
  ChainMap,
  ChainMetadata,
  Chains,
  chainMetadata,
} from '@hyperlane-xyz/sdk';
import { plumetestnet } from '@hyperlane-xyz/sdk/dist/consts/chainMetadata';

import { AgentChainNames, Role } from '../../../src/roles';

const selectedChains = [
  Chains.alfajores,
  Chains.arbitrumgoerli,
  Chains.bsctestnet,
  Chains.fuji,
  Chains.goerli,
  Chains.optimismgoerli,
  Chains.polygonzkevmtestnet,
  Chains.scrollsepolia,
  Chains.sepolia,
  Chains.plumetestnet,
];

export const testnetConfigs: ChainMap<ChainMetadata> = {
  ...Object.fromEntries(
    selectedChains.map((chain) => [chain, chainMetadata[chain]]),
  ),
  mumbai: {
    ...chainMetadata.mumbai,
    transactionOverrides: {
      maxFeePerGas: 150 * 10 ** 9, // 70 gwei
      maxPriorityFeePerGas: 40 * 10 ** 9, // 40 gwei
    },
  },
  bsctestnet: {
    ...chainMetadata.bsctestnet,
    transactionOverrides: {
      gasPrice: 80 * 10 ** 9, // 8 gwei
    },
  },
  plumetestnet: {
    ...plumetestnet,
    transactionOverrides: {
      gasPrice: 0.001 * 10 ** 9, // 0.001 gwei
    },
  },
};

export const supportedChainNames = Object.keys(testnetConfigs);
export const environment = 'testnet4';

// Hyperlane & RC context agent chain names.
export const agentChainNames: AgentChainNames = {
  [Role.Validator]: supportedChainNames,
  // Only run relayers for Ethereum chains at the moment.
  [Role.Relayer]: supportedChainNames,
  [Role.Scraper]: supportedChainNames,
};
