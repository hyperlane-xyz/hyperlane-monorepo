import { ethers } from 'hardhat';

import { initHardhatMultiProvider } from '@abacus-network/deploy/dist/src/utils';

import { CoreEnvironmentConfig } from '../../../src/config';
import { configs } from '../../networks/testnets';

import { agent } from './agent';
import { core } from './core';
import { governance } from './governance';
import { infra } from './infra';
import { metrics } from './metrics';

const coreConfig = {
  test1: configs.test1,
  test2: configs.test2,
  test3: configs.test3,
};

type corenet = keyof typeof coreConfig;

export const environment: CoreEnvironmentConfig<corenet> = {
  transactionConfigs: coreConfig,
  agent,
  core,
  governance,
  metrics,
  infra,
  getMultiProvider: async () => {
    const [signer] = await ethers.getSigners();
    return initHardhatMultiProvider({ transactionConfigs: coreConfig }, signer);
  },
};
