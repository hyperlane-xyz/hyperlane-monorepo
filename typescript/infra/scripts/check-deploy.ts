import { AbacusCore, AbacusGovernance } from '@abacus-network/sdk';
import { AbacusCoreChecker } from '../src/core';
import { AbacusGovernanceChecker } from '../src/governance';
import { getCoreEnvironmentConfig, getEnvironment } from './utils';

async function check() {
  const environment = await getEnvironment();
  const config = getCoreEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();

  if (environment !== 'test') {
    throw new Error(
      `Do not have governance addresses for ${environment} in SDK`,
    );
  }

  const core = AbacusCore.fromEnvironment(environment, multiProvider);
  const governance = AbacusGovernance.fromEnvironment(
    environment,
    multiProvider,
  );

  const governanceChecker = new AbacusGovernanceChecker(
    multiProvider,
    governance,
    config.governance,
  );
  await governanceChecker.check();
  governanceChecker.expectEmpty();

  const owners = governance.routerAddresses();
  const coreChecker = new AbacusCoreChecker(multiProvider, core, {
    ...config.core,
    owners,
  } as any);
  await coreChecker.check();
  coreChecker.expectEmpty();
}

check().then(console.log).catch(console.error);
