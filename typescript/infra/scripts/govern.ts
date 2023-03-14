import {
  HyperlaneCore,
  HyperlaneCoreChecker,
  MultiProvider,
} from '@hyperlane-xyz/sdk';

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

  const multiProvider =
    process.env.CI === 'true'
      ? new MultiProvider() // use default RPCs
      : await config.getMultiProvider();

  if (argv.fork) {
    // TODO: make this more generic
    const forkChain = environment === 'testnet3' ? 'goerli' : 'ethereum';

    // rotate chain provider to local RPC
    const provider = useLocalProvider(multiProvider, forkChain);

    // rotate chain signer to impersonated owner
    const signer = await impersonateAccount(
      provider,
      config.core[forkChain].owner,
    );
    multiProvider.setSigner(forkChain, signer);
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
  await coreChecker.check();
  coreChecker.expectViolations({});

  const governor = new HyperlaneCoreGovernor(coreChecker);
  await governor.govern();
}

check().then().catch(console.error);
