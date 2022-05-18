import { getMultiProviderFromGCP } from '../../../scripts/utils';
import { CoreEnvironmentConfig } from '../../../src/config';

import { agent } from './agent';
import { TestnetChains, testnetConfigs } from './chains';
import { controller } from './controller';
import { core } from './core';
import { infrastructure } from './infrastructure';

export const environment: CoreEnvironmentConfig<TestnetChains> = {
  transactionConfigs: testnetConfigs,
  getMultiProvider: () => getMultiProviderFromGCP(testnetConfigs, 'testnet'),
  agent,
  core,
  controller,
  infra: infrastructure,
};
