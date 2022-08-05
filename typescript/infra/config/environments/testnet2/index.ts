import { getMultiProviderForRole } from '../../../scripts/utils';
import { KEY_ROLE_ENUM } from '../../../src/agents/roles';
import { CoreEnvironmentConfig } from '../../../src/config';
import { Contexts } from '../../contexts';

import { agents } from './agent';
import {
  TestnetChains,
  environment as environmentName,
  testnetConfigs,
} from './chains';
import { core } from './core';
import { keyFunderConfig } from './funding';
import { helloWorld } from './helloworld';
import { infrastructure } from './infrastructure';

export const environment: CoreEnvironmentConfig<TestnetChains> = {
  environment: environmentName,
  transactionConfigs: testnetConfigs,
  getMultiProvider: (context?: Contexts, role?: KEY_ROLE_ENUM) =>
    getMultiProviderForRole(
      testnetConfigs,
      environmentName,
      context ?? Contexts.Abacus,
      role ?? KEY_ROLE_ENUM.Deployer,
    ),
  agents,
  core,
  infra: infrastructure,
  helloWorld,
  keyFunderConfig,
};
