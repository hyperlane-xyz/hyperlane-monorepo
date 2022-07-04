import { getMultiProviderFromGCP } from '../../../scripts/utils';
import { CoreEnvironmentConfig } from '../../../src/config';

import { agents } from './agent';
import { TestnetChains, testnetConfigs } from './chains';
import { core } from './core';
import { infrastructure } from './infrastructure';

export const environment: CoreEnvironmentConfig<TestnetChains> = {
  environment: 'testnet',
  transactionConfigs: testnetConfigs,
  getMultiProvider: (context?: string) =>
    getMultiProviderFromGCP(testnetConfigs, 'testnet', context),
  agents,
  core,
  infra: infrastructure,
};
