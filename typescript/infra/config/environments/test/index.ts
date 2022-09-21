import { JsonRpcProvider } from '@ethersproject/providers';

import { getTestMultiProvider } from '@hyperlane-xyz/sdk';

import { CoreEnvironmentConfig } from '../../../src/config';

import { agents } from './agent';
import { TestChains, testConfigs } from './chains';
import { core } from './core';
import { infra } from './infra';

export const environment: CoreEnvironmentConfig<TestChains> = {
  environment: 'test',
  transactionConfigs: testConfigs,
  agents,
  core,
  infra,
  // NOTE: Does not work from hardhat.config.ts
  getMultiProvider: async () => {
    const provider = testConfigs.test1.provider! as JsonRpcProvider;
    const signer = provider.getSigner(0);
    return getTestMultiProvider(signer, testConfigs);
  },
};
