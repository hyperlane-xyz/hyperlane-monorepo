import { HyperlaneCore, HyperlaneCoreChecker } from '@hyperlane-xyz/sdk';

import { deployEnvToSdkEnv } from '../src/config/environment';

import { getCoreEnvironmentConfig, getEnvironment } from './utils';

async function check() {
  const environment = await getEnvironment();
  const config = getCoreEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();

  // environments union doesn't work well with typescript
  const core = HyperlaneCore.fromEnvironment(
    deployEnvToSdkEnv[environment],
    multiProvider as any,
  );
  const coreChecker = new HyperlaneCoreChecker<any>(
    multiProvider,
    core,
    config.core,
  );
  await coreChecker.check();

  if (coreChecker.violations.length > 0) {
    console.table(coreChecker.violations, [
      'chain',
      'remote',
      'type',
      'subType',
      'actual',
      'expected',
    ]);
    throw new Error(
      `Checking core deploy yielded ${coreChecker.violations.length} violations`,
    );
  } else {
    console.info('CoreChecker found no violations');
  }
}

check().then(console.log).catch(console.error);
