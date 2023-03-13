import { HyperlaneCore, HyperlaneCoreChecker } from '@hyperlane-xyz/sdk';

import { deployEnvToSdkEnv } from '../src/config/environment';
import { fork } from '../src/utils/fork';

import { getCoreEnvironmentConfig, getEnvironment } from './utils';

async function check() {
  const environment = await getEnvironment();
  const config = getCoreEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();

  // fork test network and impersonate owner in CI
  if (process.env.CI == 'true') {
    const forkChain = environment === 'testnet3' ? 'goerli' : 'ethereum';
    await fork(forkChain, multiProvider, false); // don't reset fork state
  }

  // environments union doesn't work well with typescript
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

  if (coreChecker.violations.length > 0) {
    console.table(coreChecker.violations, [
      'chain',
      'remote',
      'name',
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
