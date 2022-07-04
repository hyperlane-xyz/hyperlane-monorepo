import { getMultiProviderFromGCP } from '../../../scripts/utils';
import { CoreEnvironmentConfig } from '../../../src/config';

import { agents } from './agent';
import { DevChains, devConfigs } from './chains';
import { core } from './core';
import { infrastructure } from './infrastructure';

export const environment: CoreEnvironmentConfig<DevChains> = {
  environment: 'dev',
  transactionConfigs: devConfigs,
  getMultiProvider: (context?: string) =>
    getMultiProviderFromGCP(devConfigs, 'dev', context),
  agents,
  core,
  infra: infrastructure,
};
