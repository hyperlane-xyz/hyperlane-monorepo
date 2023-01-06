import { chainConnectionConfigs } from '@hyperlane-xyz/sdk';

export const mainnetConfigs = {
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
      maxFeePerGas: 500 * 10 ** 9, // 500 gwei
      maxPriorityFeePerGas: 100 * 10 ** 9, // 100 gwei
      // gasPrice: 50 * 10 ** 9, // 50 gwei
    },
  },
  celo: {
    ...chainConnectionConfigs.celo,
    overrides: {
      gasLimit: 2_700_000,
      // gasPrice: 1 * 10 ** 9 // 1 gwei
      // maxFeePerGas: 10 * 10 ** 9, // 10 gwei
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
  moonbeam: chainConnectionConfigs.moonbeam,
};

export type MainnetChains = keyof typeof mainnetConfigs;
export const chainNames = Object.keys(mainnetConfigs) as MainnetChains[];
export const environment = 'mainnet2';
