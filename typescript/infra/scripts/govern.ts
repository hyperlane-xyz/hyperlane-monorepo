import { HyperlaneCore, HyperlaneCoreChecker } from '@hyperlane-xyz/sdk';

import { deployEnvToSdkEnv } from '../src/config/environment';
import { HyperlaneCoreGovernor } from '../src/core/govern';

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
  coreChecker.expectViolations([], []);

  const governor = new HyperlaneCoreGovernor(coreChecker);
  await governor.govern();
}

check().then(console.log).catch(console.error);
