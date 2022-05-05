import { getMultiProviderFromGCP } from '../../../scripts/utils';
import { CoreEnvironmentConfig } from '../../../src/config';
import { agent } from './agent';
import { core } from './core';
import { testnetConfigs, TestnetNetworks } from './domains';
import { governance } from './governance';
import { infrastructure } from './infrastructure';

export const environment: CoreEnvironmentConfig<TestnetNetworks> = {
  transactionConfigs: testnetConfigs,
  getMultiProvider: () => getMultiProviderFromGCP(testnetConfigs, 'testnet'),
  agent,
  core,
  governance,
  infra: infrastructure,
};
