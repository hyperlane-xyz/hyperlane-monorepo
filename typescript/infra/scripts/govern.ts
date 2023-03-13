import { HyperlaneCore, HyperlaneCoreChecker } from '@hyperlane-xyz/sdk';

import { deployEnvToSdkEnv } from '../src/config/environment';
import { HyperlaneCoreGovernor } from '../src/core/govern';
import { forkAndImpersonateOwner } from '../src/utils/fork';

import { getCoreEnvironmentConfig, getEnvironment } from './utils';

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
  coreChecker.expectViolations({});

  // fork test network and impersonate owner in CI
  if (process.env.CI == 'true') {
    const forkChain = environment === 'testnet3' ? 'goerli' : 'ethereum';
    await forkAndImpersonateOwner(forkChain, config.core, multiProvider);
  }

  const governor = new HyperlaneCoreGovernor(coreChecker);
  await governor.govern();
}

check().then(console.log).catch(console.error);
