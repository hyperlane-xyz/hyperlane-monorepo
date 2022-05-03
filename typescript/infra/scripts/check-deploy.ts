import { ethers } from 'hardhat';

import { utils } from '@abacus-network/deploy';
import { AbacusCore, AbacusGovernance } from '@abacus-network/sdk';

import { AbacusCoreChecker } from '../src/core';
import { AbacusGovernanceChecker } from '../src/governance';

import { getCoreEnvironmentConfig, getEnvironment } from './utils';

async function check() {
  const environment = await getEnvironment();
  if (environment !== 'test') {
    throw new Error(`Do not have addresses for ${environment} in SDK`);
  }

  const config = await getCoreEnvironmentConfig(environment);
  const [signer] = await ethers.getSigners();
  const multiProvider = utils.initHardhatMultiProvider(config, signer);

  const core = AbacusCore.fromEnvironment(environment, multiProvider);
  const governance = AbacusGovernance.fromEnvironment(
    environment,
    multiProvider,
  );

  const governor = await governance.governor();

  const governanceChecker = new AbacusGovernanceChecker(
    multiProvider,
    governance,
    config.governance,
  );
  await governanceChecker.check(governor);
  governanceChecker.expectEmpty();

  const coreChecker = new AbacusCoreChecker(multiProvider, core, config.core);
  await coreChecker.checkOwners(governance.routerAddresses());
  coreChecker.expectEmpty();
}

check().then(console.log).catch(console.error);
