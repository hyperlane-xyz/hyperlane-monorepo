import { getMultiProviderFromGCP } from '../../../scripts/utils';
import { CoreEnvironmentConfig } from '../../../src/config';
import { agent } from './agent';
import { core } from './core';
import { devConfigs, DevNetworks } from './domains';
import { governance } from './governance';
import { infrastructure } from './infrastructure';

export const environment: CoreEnvironmentConfig<DevNetworks> = {
  transactionConfigs: devConfigs,
  getMultiProvider: () => getMultiProviderFromGCP(devConfigs, 'dev'),
  agent,
  core,
  governance,
  infra: infrastructure,
};
