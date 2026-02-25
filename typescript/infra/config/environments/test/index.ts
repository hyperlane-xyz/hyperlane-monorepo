import { MultiProvider } from '@hyperlane-xyz/sdk';

import type { EnvironmentConfig } from '../../../src/config/environment.js';

import { agents } from './agent.js';
import { testChainNames } from './chains.js';
import { core } from './core.js';
import { igp } from './igp.js';
import { infra } from './infra.js';
import { owners } from './owners.js';

export const environment: EnvironmentConfig = {
  environment: 'test',
  supportedChainNames: testChainNames,
  getRegistry: (_useSecrets?: boolean, _chains?: string[]) => {
    throw new Error('Not implemented');
  },
  getMultiProtocolProvider: () => {
    throw new Error('Not implemented');
  },
  agents,
  core,
  igp,
  owners,
  infra,
  // NOTE: Does not work from hardhat.config.ts
  getMultiProvider: async () => {
    const mp = MultiProvider.createTestMultiProvider();
    const signer = mp.getSigner('test1');
    mp.setSharedSigner(signer);
    return mp;
  },
  getKeys: async () => {
    throw new Error('Not implemented');
  },
};
