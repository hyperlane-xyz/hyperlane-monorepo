import { chainConnectionConfigs } from '@abacus-network/sdk';

export const testnetConfigs = {
  alfajores: chainConnectionConfigs.alfajores,
  kovan: chainConnectionConfigs.kovan,
  fuji: chainConnectionConfigs.fuji,
  mumbai: {
    ...chainConnectionConfigs.mumbai,
    overrides: {
      maxFeePerGas: 100 * 10 ** 9, // 100 gwei
      maxPriorityFeePerGas: 40 * 10 ** 9, // 40 gwei
    },
  },
  bsctestnet: chainConnectionConfigs.bsctestnet,
  arbitrumrinkeby: chainConnectionConfigs.arbitrumrinkeby,
  optimismkovan: chainConnectionConfigs.optimismkovan,
};

export type TestnetChains = keyof typeof testnetConfigs;
export const chainNames = Object.keys(testnetConfigs) as TestnetChains[];
export const environment = 'testnet2';
