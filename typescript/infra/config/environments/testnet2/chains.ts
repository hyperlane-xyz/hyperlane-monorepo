import { chainConnectionConfigs } from '@hyperlane-xyz/sdk';

export const testnetConfigs = {
  alfajores: chainConnectionConfigs.alfajores,
  fuji: chainConnectionConfigs.fuji,
  mumbai: {
    ...chainConnectionConfigs.mumbai,
    confirmations: 3,
    overrides: {
      maxFeePerGas: 2 * 10 ** 9, // 1000 gwei
      maxPriorityFeePerGas: 1 * 10 ** 9, // 40 gwei
    },
  },
  bsctestnet: chainConnectionConfigs.bsctestnet,
  goerli: chainConnectionConfigs.goerli,
  moonbasealpha: chainConnectionConfigs.moonbasealpha,
};

export type TestnetChains = keyof typeof testnetConfigs;
export const chainNames = Object.keys(testnetConfigs) as TestnetChains[];
export const environment = 'testnet2';
