import { getMultiProviderFromGCP } from '../../../scripts/utils';
import { CoreEnvironmentConfig } from '../../../src/config';

import { agent } from './agent';
import {
  MainnetChains,
  environment as environmentName,
  mainnetConfigs,
} from './chains';
import { core } from './core';
import { helloWorld } from './helloworld';
import { infrastructure } from './infrastructure';

export const environment: CoreEnvironmentConfig<MainnetChains> = {
  environment: environmentName,
  transactionConfigs: mainnetConfigs,
  getMultiProvider: () =>
    getMultiProviderFromGCP(mainnetConfigs, environmentName),
  agent,
  core,
  infra: infrastructure,
  helloWorld,
};
