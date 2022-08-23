import {
  ChainMap,
  IChainConnection,
  chainConnectionConfigs,
} from '@abacus-network/sdk';

export const mainnetConfigs: ChainMap<any, IChainConnection> = {
  bsc: {
    ...chainConnectionConfigs.bsc,
    overrides: {
      gasPrice: 7 * 10 ** 9, // 7 gwei
    },
  },
  avalanche: chainConnectionConfigs.avalanche,
  polygon: {
    ...chainConnectionConfigs.polygon,
    confirmations: 3,
    overrides: {
      maxFeePerGas: 1000 * 10 ** 9, // 1000 gwei
      maxPriorityFeePerGas: 40 * 10 ** 9, // 40 gwei
      // gasPrice: 50 * 10 ** 9, // 50 gwei
    },
  },
  celo: chainConnectionConfigs.celo,
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
};

export type MainnetChains = keyof typeof mainnetConfigs;
export const chainNames = Object.keys(mainnetConfigs) as MainnetChains[];
export const environment = 'mainnet';
