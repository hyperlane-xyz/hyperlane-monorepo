import { MultiProvider } from '@abacus-network/sdk';

import { fetchSigner } from '../../../src/config/chain';
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

export const registerMultiProvider = async (multiProvider: MultiProvider) => {
  await Promise.all(
    domainNames.map(async (name) => {
      const dc = multiProvider.getDomainConnection(name);

      const signer = await fetchSigner(ENVIRONMENTS_ENUM.Testnet, name);
      dc.registerSigner(signer);

      const config = configs[name];
      if (config.confirmations) {
        dc.registerConfirmations(config.confirmations);
      }
      if (config.overrides) {
        dc.registerOverrides(config.overrides);
      }
    }),
  );
};
