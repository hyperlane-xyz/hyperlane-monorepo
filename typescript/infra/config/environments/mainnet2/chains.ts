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
  moonbeam: chainConnectionConfigs.moonbeam,
  gnosis: chainConnectionConfigs.gnosis,
};

export type MainnetChains = keyof typeof mainnetConfigs;
export const chainNames = Object.keys(mainnetConfigs) as MainnetChains[];
export const environment = 'mainnet2';
