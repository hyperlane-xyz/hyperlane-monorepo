import { getMultiProviderFromGCP } from '../../../scripts/utils';
import { CoreEnvironmentConfig } from '../../../src/config';

import { agent } from './agent';
import { TestnetChains, testnetConfigs } from './chains';
import { core } from './core';
import helloWorldAddresses from './helloworld/addresses.json';
import { infrastructure } from './infrastructure';

export const environment: CoreEnvironmentConfig<TestnetChains> = {
  transactionConfigs: testnetConfigs,
  getMultiProvider: () => getMultiProviderFromGCP(testnetConfigs, 'testnet2'),
  agent,
  core,
  infra: infrastructure,
  helloWorldAddresses,
};
