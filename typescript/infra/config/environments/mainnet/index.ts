import { getMultiProviderFromGCP } from '../../../scripts/utils';
import { CoreEnvironmentConfig } from '../../../src/config';

import { agents } from './agent';
import {
  MainnetChains,
  environment as environmentName,
  mainnetConfigs,
} from './chains';
import { core } from './core';
import { relayerFunderConfig } from './funding';
import { helloWorld } from './helloworld';
import { infrastructure } from './infrastructure';

export const environment: CoreEnvironmentConfig<MainnetChains> = {
  environment: environmentName,
  transactionConfigs: mainnetConfigs,
  getMultiProvider: (context?: string) =>
    getMultiProviderFromGCP(mainnetConfigs, environmentName, context),
  agents,
  core,
  infra: infrastructure,
  helloWorld,
  relayerFunderConfig,
};
