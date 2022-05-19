import { configs } from '../../networks/testnets';

export const testnetConfigs = {
  alfajores: configs.alfajores,
  kovan: configs.kovan,
  fuji: configs.fuji,
  mumbai: configs.mumbai,
  bsctestnet: configs.bsctestnet,
  arbitrumrinkeby: configs.arbitrumrinkeby,
  optimismkovan: configs.optimismkovan,
};

export type TestnetChains = keyof typeof testnetConfigs;
export const chainNames = Object.keys(testnetConfigs) as TestnetChains[];
