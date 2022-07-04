import { getMultiProviderFromGCP } from '../../../scripts/utils';
import { CoreEnvironmentConfig } from '../../../src/config';

import { agent } from './agent';
import { TestnetChains, testnetConfigs } from './chains';
import { core } from './core';
import { infrastructure } from './infrastructure';

export const environment: CoreEnvironmentConfig<TestnetChains> = {
  environment: 'testnet',
  transactionConfigs: testnetConfigs,
  getMultiProvider: () => getMultiProviderFromGCP(testnetConfigs, 'testnet'),
  agent,
  agents: {},
  core,
  infra: infrastructure,
};
