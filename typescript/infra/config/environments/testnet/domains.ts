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

export type TestnetNetworks = keyof typeof testnetConfigs;
export const domainNames = Object.keys(testnetConfigs) as TestnetNetworks[];
