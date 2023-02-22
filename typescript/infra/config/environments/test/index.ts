import { JsonRpcProvider } from '@ethersproject/providers';

import { MultiProvider } from '@hyperlane-xyz/sdk';

import { CoreEnvironmentConfig } from '../../../src/config';

import { agents } from './agent';
import { testConfigs } from './chains';
import { core } from './core';
import { infra } from './infra';

export const environment: CoreEnvironmentConfig = {
  environment: 'test',
  chainMetadataConfigs: testConfigs,
  agents,
  core,
  infra,
  // NOTE: Does not work from hardhat.config.ts
  getMultiProvider: async () => {
    const mp = MultiProvider.createTestMultiProvider();
    const provider = mp.getProvider('test1') as JsonRpcProvider;
    const signer = provider.getSigner(0);
    mp.setSharedSigner(signer);
    return mp;
  },
};
