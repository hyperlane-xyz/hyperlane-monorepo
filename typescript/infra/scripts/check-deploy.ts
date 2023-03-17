import {
  HyperlaneCore,
  HyperlaneCoreChecker,
  HyperlaneIgp,
  HyperlaneIgpChecker,
} from '@hyperlane-xyz/sdk';

import { deployEnvToSdkEnv } from '../src/config/environment';
import { HyperlaneCoreGovernor } from '../src/core/govern';
import { HyperlaneIgpGovernor } from '../src/gas/govern';
import { HyperlaneAppGovernor } from '../src/govern/HyperlaneAppGovernor';

import {
  getArgsWithModule,
  getEnvironment,
  getEnvironmentConfig,
} from './utils';

async function check() {
  const { govern, module } = await getArgsWithModule()
    .boolean('govern')
    .alias('g', 'govern').argv;
  const environment = await getEnvironment();
  const config = await getEnvironmentConfig();
  const multiProvider = await config.getMultiProvider();

  let governor: HyperlaneAppGovernor<any, any>;
  const env = deployEnvToSdkEnv[environment];
  switch (module) {
    case 'core': {
      const core = HyperlaneCore.fromEnvironment(env, multiProvider);
      const checker = new HyperlaneCoreChecker(
        multiProvider,
        core,
        config.core,
      );
      governor = new HyperlaneCoreGovernor(checker, config.owners);
      break;
    }
    case 'igp': {
      const igp = HyperlaneIgp.fromEnvironment(env, multiProvider);
      const checker = new HyperlaneIgpChecker(multiProvider, igp, config.igp);
      governor = new HyperlaneIgpGovernor(checker, config.owners);
      break;
    }
    default:
      throw new Error('Unknown module type');
  }
  await governor.checker.check();

  if (!govern) {
    const violations = governor.checker.violations;
    if (violations.length > 0) {
      console.table(violations, [
        'chain',
        'remote',
        'name',
        'type',
        'subType',
        'actual',
        'expected',
      ]);
      throw new Error(
        `Checking ${module} deploy yielded ${violations.length} violations`,
      );
    } else {
      console.info('CoreChecker found no violations');
    }
  } else {
    governor.checker.expectViolations({ Transparent: 1 });
    await governor.govern();
  }
}

check().then(console.log).catch(console.error);
