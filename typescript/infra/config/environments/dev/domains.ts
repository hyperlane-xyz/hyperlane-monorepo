import { registerDomains } from '@abacus-network/deploy';
import { MultiProvider } from '@abacus-network/sdk';

import { fetchSigner } from '../../../src/config/chain';
import { ENVIRONMENTS_ENUM } from '../../../src/config/environment';
import { configs } from '../../networks/testnets';

export type DevNetworks = 'alfajores' | 'kovan';

export const domainNames: DevNetworks[] = ['alfajores', 'kovan'];

export const registerMultiProvider = async (multiProvider: MultiProvider) => {
  registerDomains(domainNames, configs, multiProvider);

  await Promise.all(
    domainNames.map(async (name) => {
      const signer = await fetchSigner(ENVIRONMENTS_ENUM.Dev, name);
      multiProvider.registerSigner(name, signer);
    }),
  );
};
