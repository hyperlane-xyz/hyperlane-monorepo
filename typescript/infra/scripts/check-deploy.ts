import { AbacusCore, AbacusCoreChecker } from '@abacus-network/sdk';

import { getCoreEnvironmentConfig, getEnvironment } from './utils';

async function check() {
  const environment = await getEnvironment();
  const config = getCoreEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();

  // environments union doesn't work well with typescript
  const core = AbacusCore.fromEnvironment(environment, multiProvider as any);
  const coreChecker = new AbacusCoreChecker<any>(
    multiProvider,
    core,
    config.core,
  );
  await coreChecker.check();

  if (coreChecker.violations.length > 0) {
    console.error(coreChecker.violations);
    throw new Error(
      `Checking core deploy yielded ${coreChecker.violations.length} violations`,
    );
  }
}

check().then(console.log).catch(console.error);
