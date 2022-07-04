import { getMultiProviderFromGCP } from '../../../scripts/utils';
import { CoreEnvironmentConfig } from '../../../src/config';

import { agent, agents } from './agent';
import {
  TestnetChains,
  environment as environmentName,
  testnetConfigs,
} from './chains';
import { core } from './core';
import { relayerFunderConfig } from './funding';
import { helloWorld } from './helloworld';
import { infrastructure } from './infrastructure';

export const environment: CoreEnvironmentConfig<TestnetChains> = {
  environment: environmentName,
  transactionConfigs: testnetConfigs,
  getMultiProvider: () =>
    getMultiProviderFromGCP(testnetConfigs, environmentName),
  agent,
  agents,
  core,
  infra: infrastructure,
  helloWorld,
  relayerFunderConfig,
};
