import { chainConnectionConfigs } from '@abacus-network/sdk';

export const testnetConfigs = {
  alfajores: chainConnectionConfigs.alfajores,
  kovan: chainConnectionConfigs.kovan,
  fuji: chainConnectionConfigs.fuji,
  mumbai: chainConnectionConfigs.mumbai,
  bsctestnet: chainConnectionConfigs.bsctestnet,
  arbitrumrinkeby: chainConnectionConfigs.arbitrumrinkeby,
  optimismkovan: chainConnectionConfigs.optimismkovan,
};

export type TestnetChains = keyof typeof testnetConfigs;
export const chainNames = Object.keys(testnetConfigs) as TestnetChains[];
export const environment = 'testnet2';
