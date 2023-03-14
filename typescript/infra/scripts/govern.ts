import { HyperlaneCore, HyperlaneCoreChecker } from '@hyperlane-xyz/sdk';

import { deployEnvToSdkEnv } from '../src/config/environment';
import { HyperlaneCoreGovernor } from '../src/core/govern';

import { getCoreEnvironmentConfig, getEnvironment } from './utils';

// TODO: Switch between core/igp based on flag
async function check() {
  const environment = await getEnvironment();
  const config = getCoreEnvironmentConfig(environment);

  const multiProvider = await config.getMultiProvider();

  const core = HyperlaneCore.fromEnvironment(
    deployEnvToSdkEnv[environment],
    multiProvider,
  );

  const coreChecker = new HyperlaneCoreChecker(
    multiProvider,
    core,
    config.core,
  );
  await coreChecker.check();
  coreChecker.expectViolations({ Transparent: 1 });

  const governor = new HyperlaneCoreGovernor(coreChecker);
  await governor.govern();
}

check().then(console.log).catch(console.error);
