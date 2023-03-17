import { HyperlaneCore, HyperlaneCoreChecker } from '@hyperlane-xyz/sdk';

import { deployEnvToSdkEnv } from '../src/config/environment';
import { HyperlaneCoreGovernor } from '../src/core/govern';
import { impersonateAccount, useLocalProvider } from '../src/utils/fork';

import {
  assertEnvironment,
  getArgsWithFork,
  getCoreEnvironmentConfig,
} from './utils';

async function check() {
  const argv = await getArgsWithFork().argv;
  const environment = assertEnvironment(argv.environment);
  const config = getCoreEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();

  // must rotate to forked provider before building core contracts
  if (argv.fork) {
    await useLocalProvider(multiProvider, argv.fork);
    const owner = config.core[argv.fork].owner;
    const signer = await impersonateAccount(owner);
    multiProvider.setSigner(argv.fork, signer);
  }

  const core = HyperlaneCore.fromEnvironment(
    deployEnvToSdkEnv[environment],
    multiProvider,
  );

  const coreChecker = new HyperlaneCoreChecker(
    multiProvider,
    core,
    config.core,
  );
  const governor = new HyperlaneCoreGovernor(coreChecker);

  if (argv.fork) {
    await coreChecker.checkChain(argv.fork);
    await governor.governChain(argv.fork, false);
  } else {
    await coreChecker.check();
    await governor.govern();
  }
}

check()
  .then()
  .catch(() => process.exit(1));
