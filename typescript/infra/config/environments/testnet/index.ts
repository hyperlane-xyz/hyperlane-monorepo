import { getMultiProviderFromGCP } from '../../../scripts/utils';
import { CoreEnvironmentConfig } from '../../../src/config';

import { agent } from './agent';
import { controller } from './controller';
import { core } from './core';
import { TestnetNetworks, testnetConfigs } from './domains';
import { infrastructure } from './infrastructure';

export const environment: CoreEnvironmentConfig<TestnetNetworks> = {
  transactionConfigs: testnetConfigs,
  getMultiProvider: () => getMultiProviderFromGCP(testnetConfigs, 'testnet'),
  agent,
  core,
  controller,
  infra: infrastructure,
};
