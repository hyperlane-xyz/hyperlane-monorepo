import { getMultiProviderFromGCP } from '../../../scripts/utils';
import { ENVIRONMENTS_ENUM } from '../../../src/config/environment';
import { configs } from '../../networks/testnets';

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

export const getMultiProvider = () =>
  getMultiProviderFromGCP(domainNames, configs, ENVIRONMENTS_ENUM.Testnet);
