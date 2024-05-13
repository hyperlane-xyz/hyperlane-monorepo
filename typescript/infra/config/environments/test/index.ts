import { JsonRpcProvider } from '@ethersproject/providers';

import { MultiProvider, testChainMetadata } from '@hyperlane-xyz/sdk';

import { EnvironmentConfig } from '../../../src/config/environment.js';

import { agents } from './agent.js';
import { core } from './core.js';
import { igp } from './igp.js';
import { infra } from './infra.js';
import { owners } from './owners.js';

export const environment: EnvironmentConfig = {
  environment: 'test',
  chainMetadataConfigs: testChainMetadata,
  agents,
  core,
  igp,
  owners,
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
