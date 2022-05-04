import { getMultiProviderFromGCP } from '../../../scripts/utils';
import { ENVIRONMENTS_ENUM } from '../../../src/config/environment';
import { configs } from '../../networks/testnets';

// TODO: infer networks from configs

export type TestnetNetworks =
  | 'alfajores'
  | 'kovan'
  | 'fuji'
  | 'mumbai'
  | 'bsctestnet'
  | 'arbitrumrinkeby'
  | 'optimismkovan'
  | 'auroratestnet';

export const domainNames: TestnetNetworks[] = [
  'alfajores',
  'kovan',
  'fuji',
  'mumbai',
  'bsctestnet',
  'arbitrumrinkeby',
  'optimismkovan',
  'auroratestnet',
];

const testnetConfigs = {
  alfajores: configs.alfajores,
  kovan: configs.kovan,
  fuji: configs.fuji,
  mumbai: configs.mumbai,
  bsctestnet: configs.bsctestnet,
  arbitrumrinkeby: configs.arbitrumrinkeby,
  optimismkovan: configs.optimismkovan,
  auroratestnet: configs.auroratestnet,
};

export const getMultiProvider = () =>
  getMultiProviderFromGCP(testnetConfigs, ENVIRONMENTS_ENUM.Testnet);
