import { getMultiProviderFromGCP } from '../../../scripts/utils';
import { CoreEnvironmentConfig } from '../../../src/config';

import { agent } from './agent';
import { core } from './core';
import { DevNetworks, devConfigs } from './domains';
import { controller } from './controller';
import { infrastructure } from './infrastructure';

export const environment: CoreEnvironmentConfig<DevNetworks> = {
  transactionConfigs: devConfigs,
  getMultiProvider: () => getMultiProviderFromGCP(devConfigs, 'dev'),
  agent,
  core,
  controller,
  infra: infrastructure,
};
