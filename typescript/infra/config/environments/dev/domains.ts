import { getMultiProviderFromGCP } from '../../../scripts/utils';
import { ENVIRONMENTS_ENUM } from '../../../src/config/environment';
import { configs } from '../../networks/testnets';

const devConfigs = {
  alfajores: configs.alfajores,
  kovan: configs.kovan,
};

export type DevNetworks = 'alfajores' | 'kovan';
export const domainNames: DevNetworks[] = ['alfajores', 'kovan'];

export const getMultiProvider = () =>
  getMultiProviderFromGCP(devConfigs, ENVIRONMENTS_ENUM.Dev);
