import {
  HyperlaneCore,
  HyperlaneCoreChecker,
  MultiProvider,
} from '@hyperlane-xyz/sdk';

import { deployEnvToSdkEnv } from '../src/config/environment';
import { useLocalProvider } from '../src/utils/fork';

import {
  assertEnvironment,
  getArgsWithFork,
  getCoreEnvironmentConfig,
} from './utils';

async function check() {
  const argv = await getArgsWithFork().argv;
  const environment = assertEnvironment(argv.environment);
  const config = getCoreEnvironmentConfig(environment);

  const multiProvider =
    process.env.CI === 'true'
      ? new MultiProvider() // use default RPCs
      : await config.getMultiProvider();

  if (argv.fork) {
    // TODO: make this more generic
    const forkChain = environment === 'testnet3' ? 'goerli' : 'ethereum';

    // rotate chain provider to local RPC
    useLocalProvider(multiProvider, forkChain);
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
