import { chainConnectionConfigs } from '@hyperlane-xyz/sdk';

export const testnetConfigs = {
  alfajores: chainConnectionConfigs.alfajores,
  fuji: chainConnectionConfigs.fuji,
  mumbai: {
    ...chainConnectionConfigs.mumbai,
    confirmations: 3,
    overrides: {
      maxFeePerGas: 70 * 10 ** 9, // 70 gwei
      maxPriorityFeePerGas: 40 * 10 ** 9, // 40 gwei
    },
  },
  bsctestnet: chainConnectionConfigs.bsctestnet,
  goerli: chainConnectionConfigs.goerli,
  // moonbasealpha: chainConnectionConfigs.moonbasealpha,
  optimismgoerli: chainConnectionConfigs.optimismgoerli,
  arbitrumgoerli: chainConnectionConfigs.arbitrumgoerli,
};

export type TestnetChains = keyof typeof testnetConfigs;
export const chainNames = Object.keys(testnetConfigs) as TestnetChains[];
export const environment = 'testnet3';
