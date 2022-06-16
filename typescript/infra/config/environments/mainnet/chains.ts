import {
  ChainMap,
  IChainConnection,
  chainConnectionConfigs,
} from '@abacus-network/sdk';

export const mainnetConfigs: ChainMap<any, IChainConnection> = {
  bsc: {
    ...chainConnectionConfigs.bsc,
    overrides: {
      gasPrice: 7 * 10 ** 9,
    },
  },
  avalanche: chainConnectionConfigs.avalanche,
  polygon: {
    ...chainConnectionConfigs.polygon,
    confirmations: 3,
    overrides: {
      maxFeePerGas: 100 * 10 ** 9, // gwei
      maxPriorityFeePerGas: 40 * 10 ** 9, // gwei
      // gasPrice: 50 * 10 ** 9, // gwei
    },
  },
  arbitrum: chainConnectionConfigs.arbitrum,
  optimism: chainConnectionConfigs.optimism,
  ethereum: {
    ...chainConnectionConfigs.ethereum,
    confirmations: 3,
    overrides: {
      maxFeePerGas: 150 * 10 ** 9, // gwei
      maxPriorityFeePerGas: 5 * 10 ** 9, // gwei
    },
  },
  celo: chainConnectionConfigs.celo,
};

export type MainnetChains = keyof typeof mainnetConfigs;
export const chainNames = Object.keys(mainnetConfigs) as MainnetChains[];
