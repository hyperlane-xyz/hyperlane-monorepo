import { JsonRpcProvider } from '@ethersproject/providers';

import { getMultiProviderFromConfigAndSigner } from '@abacus-network/sdk';

import { CoreEnvironmentConfig } from '../../../src/config';

import { agent } from './agent';
import { TestChains, testConfigs } from './chains';
import { core } from './core';
import { infra } from './infra';

export const environment: CoreEnvironmentConfig<TestChains> = {
  environment: 'test',
  transactionConfigs: testConfigs,
  agent,
  core,
  infra,
  // NOTE: Does not work from hardhat.config.ts
  getMultiProvider: async () => {
    const provider = testConfigs.test1.provider! as JsonRpcProvider;
    const signer = provider.getSigner(0);
    return getMultiProviderFromConfigAndSigner(testConfigs, signer);
  },
};
