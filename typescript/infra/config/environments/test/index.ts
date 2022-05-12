import { utils } from '@abacus-network/deploy';

import { CoreEnvironmentConfig } from '../../../src/config';

import { agent } from './agent';
import { core } from './core';
import { TestNetworks, testConfigs } from './domains';
import { controller } from './controller';
import { infra } from './infra';

export const environment: CoreEnvironmentConfig<TestNetworks> = {
  transactionConfigs: testConfigs,
  agent,
  core,
  controller,
  infra,
  // NOTE: Does not work from hardhat.config.ts
  getMultiProvider: async () => {
    const hre = await import('hardhat');
    await import('@nomiclabs/hardhat-ethers');
    const [signer] = await hre.ethers.getSigners();
    return utils.getMultiProviderFromConfigAndSigner(testConfigs, signer);
  },
};
