import { JsonRpcProvider } from '@ethersproject/providers';

import { MultiProvider } from '@hyperlane-xyz/sdk';

import { EnvironmentConfig } from '../../../src/config';

import { agents } from './agent';
import { testConfigs } from './chains';
import { core } from './core';
import { storageGasOracleConfig } from './gas-oracle';
import { igp } from './igp';
import { infra } from './infra';
import { owners } from './owners';

export const environment: EnvironmentConfig = {
  environment: 'test',
  chainMetadataConfigs: testConfigs,
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
  storageGasOracleConfig,
};
