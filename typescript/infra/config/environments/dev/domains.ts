import { getMultiProviderFromGCP } from '../../../scripts/utils';
import { ENVIRONMENTS_ENUM } from '../../../src/config/environment';
import { configs } from '../../networks/testnets';

export type DevNetworks = 'alfajores' | 'kovan';

export const domainNames: DevNetworks[] = ['alfajores', 'kovan'];

export const getMultiProvider = () =>
  getMultiProviderFromGCP(domainNames, configs, ENVIRONMENTS_ENUM.Dev);
