import { JsonRpcProvider } from '@ethersproject/providers';

import {
  MultiProvider,
  testConfigs,
  core as testCore,
  owners as testOwners,
} from '@hyperlane-xyz/sdk';

import { EnvironmentConfig } from '../../../src/config';

import { agents } from './agent';
import { infra } from './infra';

export const environment: EnvironmentConfig = {
  environment: 'test',
  chainMetadataConfigs: testConfigs,
  agents,
  core: testCore,
  owners: testOwners,
  infra,
  // NOTE: Does not work from hardhat.config.ts
  getMultiProvider: async () => {
    const mp = MultiProvider.createTestMultiProvider();
    const provider = mp.getProvider('test1') as JsonRpcProvider;
    const signer = provider.getSigner(0);
    mp.setSharedSigner(signer);
    return mp;
  },
  getKeys: async () => {
    throw new Error('Not implemented');
  },
};
