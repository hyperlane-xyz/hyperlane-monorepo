import { MultiProvider } from '@abacus-network/sdk';
import { registerDomains } from '@abacus-network/deploy';
import { fetchSigner } from '../../../src/config/chain';
import { ENVIRONMENTS_ENUM } from '../../../src/config/environment';
import { configs } from '../../networks/testnets';

export type TestnetNetworks = 'alfajores' |
  'kovan' |
  'fuji' |
  'mumbai' |
  'bsctestnet' |
  'arbitrumrinkeby' |
  'optimismkovan' |
  'auroratestnet';

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
  registerDomains(domainNames, configs, multiProvider);

  await Promise.all(
    domainNames.map(async (name) => {
      const signer = await fetchSigner(ENVIRONMENTS_ENUM.Testnet, name);
      multiProvider.registerSigner(name, signer);
    }),
  );
};
