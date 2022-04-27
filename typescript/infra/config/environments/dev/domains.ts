import { MultiProvider } from '@abacus-network/sdk';
import { fetchSigner } from '../../../src/config/chain';
import { ENVIRONMENTS_ENUM } from '../../../src/config/environment';

export type DevNetworks = 'alfajores' | 'kovan';

export const domainNames: DevNetworks[] = ['alfajores', 'kovan'];

export const registerMultiProvider = async (multiProvider: MultiProvider) => {
  await Promise.all(
    domainNames.map(async (network) => {
      const signer = await fetchSigner(ENVIRONMENTS_ENUM.Dev, network);
      multiProvider.getDomainConnection(network).registerSigner(signer);
    }),
  );
};
