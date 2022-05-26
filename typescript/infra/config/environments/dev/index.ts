import { getMultiProviderFromGCP } from '../../../scripts/utils';
import { CoreEnvironmentConfig } from '../../../src/config';

import { agent } from './agent';
import { DevChains, devConfigs } from './chains';
import { core } from './core';
import { infrastructure } from './infrastructure';

export const environment: CoreEnvironmentConfig<DevChains> = {
  transactionConfigs: devConfigs,
  getMultiProvider: () => getMultiProviderFromGCP(devConfigs, 'dev'),
  agent,
  core,
  infra: infrastructure,
};
