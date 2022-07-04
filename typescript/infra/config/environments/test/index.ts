import { JsonRpcProvider } from '@ethersproject/providers';

import { utils } from '@abacus-network/deploy';

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
  getMultiProvider: async (_?: string) => {
    const provider = testConfigs.test1.provider! as JsonRpcProvider;
    const signer = provider.getSigner(0);
    return utils.getMultiProviderFromConfigAndSigner(testConfigs, signer);
  },
};
