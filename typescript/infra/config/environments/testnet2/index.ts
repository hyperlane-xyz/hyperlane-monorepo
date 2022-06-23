import { getMultiProviderFromGCP } from '../../../scripts/utils';
import { CoreEnvironmentConfig } from '../../../src/config';

import { agent } from './agent';
import {
  TestnetChains,
  environment as environmentName,
  testnetConfigs,
} from './common';
import { core } from './core';
import { helloWorld } from './helloworld';
import { infrastructure } from './infrastructure';

export const environment: CoreEnvironmentConfig<TestnetChains> = {
  environment: environmentName,
  transactionConfigs: testnetConfigs,
  getMultiProvider: () =>
    getMultiProviderFromGCP(testnetConfigs, environmentName),
  agent,
  core,
  infra: infrastructure,
  helloWorld,
};
