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

  // must rotate to forked provider before building core contracts
  if (argv.fork) {
    await useLocalProvider(multiProvider);
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
    const { provider, network } = await useLocalProvider(multiProvider);
    // rotate chain signer to impersonated owner
    const signer = await impersonateAccount(
      provider,
      config.core[network.name].owner,
    );
    multiProvider.setSigner(network.name, signer);

    await coreChecker.checkChain(network.name);
    await governor.governChain(network.name, true);
    return;
  }

  await coreChecker.check();
  await governor.govern();
}

check().then().catch(console.error);
