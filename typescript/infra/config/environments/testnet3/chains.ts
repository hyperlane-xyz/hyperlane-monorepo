import { ChainMap, ChainMetadata, chainMetadata } from '@hyperlane-xyz/sdk';

export const ethereumTestnetConfigs: ChainMap<ChainMetadata> = {
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
export type TestnetChains = keyof typeof ethereumTestnetConfigs;
export const chainNames = Object.keys(
  ethereumTestnetConfigs,
) as TestnetChains[];
export const environment = 'testnet3';

export const blessedNonEthereumTestnetConfigs: ChainMap<ChainMetadata> = {
  solanadevnet: chainMetadata.solanadevnet,
};

export const testnetConfigs: ChainMap<ChainMetadata> = {
  ...ethereumTestnetConfigs,
  ...blessedNonEthereumTestnetConfigs,
  // zbctestnet: chainMetadata.zbctestnet,
};

// Chains that we want to run agents for.
// export const agentChainNames = [...chainNames, 'solanadevnet', 'zbctestnet'];
export const agentChainNames = Object.keys(testnetConfigs) as TestnetChains[];
