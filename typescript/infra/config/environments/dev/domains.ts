import { ChainName, MultiProvider } from '@abacus-network/sdk';
import { registerDomains } from '@abacus-network/deploy';
import { fetchSigner } from '../../../src/config/chain';
import { ENVIRONMENTS_ENUM } from '../../../src/config/environment';
import { configs } from '../../networks/testnets';

export const domainNames: ChainName[] = [
  'alfajores',
  'kovan',
];

export const registerMultiProvider = async (multiProvider: MultiProvider) => {
  registerDomains(domainNames, configs, multiProvider);

  await Promise.all(
    domainNames.map(async (name) => {
      const signer = await fetchSigner(ENVIRONMENTS_ENUM.Dev, name);
      multiProvider.registerSigner(name, signer);
    })
  );
};
