import {
  AbacusCore,
  AbacusCoreChecker,
  CoreViolationType,
} from '@hyperlane-xyz/sdk';

import { AbacusCoreGovernor } from '../src/core/govern';

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
  // One validator violation per chain (test add validator)
  coreChecker.expectViolations([CoreViolationType.ValidatorManager], [1 * 7]);

  const governor = new AbacusCoreGovernor(coreChecker);
  await governor.govern();
}

check().then(console.log).catch(console.error);
