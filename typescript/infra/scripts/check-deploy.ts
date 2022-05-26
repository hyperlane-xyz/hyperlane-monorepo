import { AbacusCore } from '@abacus-network/sdk';

import { AbacusCoreChecker } from '../src/core';

import { getCoreEnvironmentConfig, getEnvironment } from './utils';

async function check() {
  const environment = await getEnvironment();
  const config = getCoreEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();

  const core = AbacusCore.fromEnvironment(environment, multiProvider);
  const coreChecker = new AbacusCoreChecker<any>(
    multiProvider,
    core,
    config.core,
  );
  await coreChecker.check();
  coreChecker.expectEmpty();
}

check().then(console.log).catch(console.error);
