import {
  HyperlaneAppChecker,
  HyperlaneCore,
  HyperlaneCoreChecker,
  HyperlaneIgp,
  HyperlaneIgpChecker,
} from '@hyperlane-xyz/sdk';

import { deployEnvToSdkEnv } from '../src/config/environment';
import { HyperlaneCoreGovernor } from '../src/core/govern';
import { HyperlaneIgpGovernor } from '../src/gas/govern';
import { HyperlaneAppGovernor } from '../src/govern/HyperlaneAppGovernor';

import { getArgs, getCoreEnvironmentConfig, getEnvironment } from './utils';

async function check() {
  const { govern, module } = await getArgs()
    .string('module')
    .choices('module', ['core', 'igp'])
    .demandOption('module')
    .alias('m', 'module')
    .boolean('govern')
    .alias('g', 'govern').argv;
  const environment = await getEnvironment();
  const config = getCoreEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();

  let checker: HyperlaneAppChecker<any, any>;
  let governor: HyperlaneAppGovernor<any, any>;
  switch (module) {
    case 'core': {
      const core = HyperlaneCore.fromEnvironment(
        deployEnvToSdkEnv[environment],
        multiProvider,
      );
      checker = new HyperlaneCoreChecker(multiProvider, core, config.core);
      governor = new HyperlaneCoreGovernor(
        checker as HyperlaneCoreChecker,
        config.owners,
      );
      break;
    }
    case 'igp': {
      const igp = HyperlaneIgp.fromEnvironment(
        deployEnvToSdkEnv[environment],
        multiProvider,
      );
      checker = new HyperlaneIgpChecker(multiProvider, igp, config.igp);
      governor = new HyperlaneIgpGovernor(
        checker as HyperlaneIgpChecker,
        config.owners,
      );
      break;
    }
    default:
      throw new Error('Unknown module type');
  }
  // environments union doesn't work well with typescript
  await checker.check();

  if (!govern) {
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
  } else {
    checker.expectViolations({ Transparent: 1 });
    await governor.govern();
  }
}

check().then(console.log).catch(console.error);
