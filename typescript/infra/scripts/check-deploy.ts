import { utils } from '@abacus-network/deploy';
import {
  AbacusCore,
  AbacusGovernance,
  coreEnvironments,
} from '@abacus-network/sdk';
import { AbacusCoreChecker } from '../src/core';
import { AbacusGovernanceChecker } from '../src/governance';
import { getCoreEnvironmentConfig, getEnvironment } from './utils';

async function check() {
  const environment = await getEnvironment();
  if (environment !== 'test') {
    throw new Error(`Do not have addresses for ${environment} in SDK`);
  }

  const config = await getCoreEnvironmentConfig(environment);

  const multiProvider = utils.initHardhatMultiProvider(config);

  const core = AbacusCore.fromEnvironment(environment, multiProvider);
  const governance = AbacusGovernance.fromEnvironment(
    environment,
    multiProvider,
  );

  const governors = await governance.governors();

  const governanceChecker = new AbacusGovernanceChecker(
    multiProvider,
    governance,
    config.governance,
  );
  await governanceChecker.check(governors);
  governanceChecker.expectEmpty();

  const coreChecker = new AbacusCoreChecker(multiProvider, core, config.core);
  await coreChecker.check(
    governance.routerAddresses(),
    coreEnvironments[environment],
  );
  coreChecker.expectEmpty();
}

check().then(console.log).catch(console.error);
