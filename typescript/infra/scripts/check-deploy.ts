import fetch from 'cross-fetch';

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

  console.log(process.env.CI === 'true');
  const multiProvider =
    process.env.CI === 'true'
      ? new MultiProvider() // use default RPCs
      : await config.getMultiProvider();

  // must rotate to forked provider before building core contracts
  if (argv.fork) {
    console.log('test');
    const resp = await fetch('http://localhost:8545', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_chainId',
      }),
    });
    console.log('got chain ID', await resp.json());
    await useLocalProvider(multiProvider, argv.fork);
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

  if (argv.fork) {
    await coreChecker.checkChain(argv.fork);
  } else {
    await coreChecker.check();
  }

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

check().then().catch(console.error);
