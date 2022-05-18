import { utils } from '@abacus-network/deploy';

import { CoreEnvironmentConfig } from '../../../src/config';

import { agent } from './agent';
import { TestChains, testConfigs } from './chains';
import { controller } from './controller';
import { core } from './core';
import { infra } from './infra';

export const environment: CoreEnvironmentConfig<TestChains> = {
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
