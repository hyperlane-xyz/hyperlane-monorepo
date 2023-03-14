import {
  HyperlaneAppChecker,
  HyperlaneCore,
  HyperlaneCoreChecker,
  HyperlaneIgp,
  HyperlaneIgpChecker,
} from '@hyperlane-xyz/sdk';

import { deployEnvToSdkEnv } from '../src/config/environment';

import { getArgs, getCoreEnvironmentConfig, getEnvironment } from './utils';

async function check() {
  const { module } = await getArgs()
    .string('module')
    .choices('module', ['core', 'igp'])
    .demandOption('module')
    .alias('m', 'module').argv;
  const environment = await getEnvironment();
  const config = getCoreEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();

  let checker: HyperlaneAppChecker<any, any>;
  switch (module) {
    case 'core':
      const core = HyperlaneCore.fromEnvironment(
        deployEnvToSdkEnv[environment],
        multiProvider,
      );
      checker = new HyperlaneCoreChecker(multiProvider, core, config.core);
      break;
    case 'igp':
      const igp = HyperlaneIgp.fromEnvironment(
        deployEnvToSdkEnv[environment],
        multiProvider,
      );
      checker = new HyperlaneIgpChecker(multiProvider, igp, config.igp);
      break;
    default:
      throw new Error('Unknown module type');
  }
  // environments union doesn't work well with typescript
  await checker.check();

  if (checker.violations.length > 0) {
    console.table(checker.violations, [
      'chain',
      'remote',
      'name',
      'type',
      'subType',
      'actual',
      'expected',
    ]);
    throw new Error(
      `Checking ${module} deploy yielded ${checker.violations.length} violations`,
    );
  } else {
    console.info('CoreChecker found no violations');
  }
}

check().then(console.log).catch(console.error);
