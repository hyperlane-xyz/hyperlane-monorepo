import { AbacusCore, AbacusGovernance, MultiProvider } from '@abacus-network/sdk';

import { AbacusCoreChecker } from '../src/core';
import { AbacusGovernanceChecker } from '../src/governance';

import {
  getCoreEnvironmentConfig,
  getEnvironment,
} from './utils';

async function check() {
  const environment = await getEnvironment();

  const config = await getCoreEnvironmentConfig(environment);
  const multiProvider = new MultiProvider(['kovan'])

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
