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

  // must rotate to forked provider before building core contracts
  if (argv.fork) {
    await useLocalProvider(multiProvider);
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
    const { network } = await useLocalProvider(multiProvider);
    await coreChecker.checkChain(network.name);
  } else {
    await coreChecker.check();
  }

  if (coreChecker.violations.length > 0) {
    const violation = coreChecker.violations[0];
    const desc = (s: any) =>
      `${Object.keys(s)
        .map((remote) => {
          const expected = s[remote];
          return `destination gas overhead for ${remote} to ${expected}`;
        })
        .join('\n')}`;
    console.log('ACTUAL:', desc(violation.actual));
    console.log('EXPECTED:', desc(violation.expected));
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
