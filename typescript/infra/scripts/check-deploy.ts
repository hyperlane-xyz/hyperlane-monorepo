import {
  HyperlaneCore,
  HyperlaneCoreChecker,
  HyperlaneIgp,
  HyperlaneIgpChecker,
  InterchainAccount,
  InterchainAccountChecker,
  InterchainQuery,
  InterchainQueryChecker,
} from '@hyperlane-xyz/sdk';
import { HyperlaneIsmFactory } from '@hyperlane-xyz/sdk/dist/ism/HyperlaneIsmFactory';

import { deployEnvToSdkEnv } from '../src/config/environment';
import { HyperlaneAppGovernor } from '../src/govern/HyperlaneAppGovernor';
import { HyperlaneCoreGovernor } from '../src/govern/HyperlaneCoreGovernor';
import { HyperlaneIgpGovernor } from '../src/govern/HyperlaneIgpGovernor';
import { ProxiedRouterGovernor } from '../src/govern/ProxiedRouterGovernor';
import { impersonateAccount, useLocalProvider } from '../src/utils/fork';

import {
  Modules,
  getEnvironmentConfig,
  getArgs as getRootArgs,
  getRouterConfig,
  withModuleAndFork,
} from './utils';

function getArgs() {
  return withModuleAndFork(getRootArgs())
    .boolean('govern')
    .default('govern', false)
    .alias('g', 'govern').argv;
}

async function check() {
  const { fork, govern, module, environment } = await getArgs();
  const config = getEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();

  // must rotate to forked provider before building core contracts
  if (fork) {
    const onlyFork = fork[0];
    await useLocalProvider(multiProvider, onlyFork, 'http://127.0.0.1:8545');
    if (govern) {
      const owner = config.core[onlyFork].owner;
      const signer = await impersonateAccount(owner, 'http://127.0.0.1:8545');
      multiProvider.setSigner(onlyFork, signer);
    }
  }

  let governor: HyperlaneAppGovernor<any, any>;
  const env = deployEnvToSdkEnv[environment];
  if (module === Modules.CORE) {
    const core = HyperlaneCore.fromEnvironment(env, multiProvider);
    const ismFactory = HyperlaneIsmFactory.fromEnvironment(env, multiProvider);
    const checker = new HyperlaneCoreChecker(
      multiProvider,
      core,
      config.core,
      ismFactory,
    );
    governor = new HyperlaneCoreGovernor(checker, config.owners);
  } else if (module === Modules.INTERCHAIN_GAS_PAYMASTER) {
    const igp = HyperlaneIgp.fromEnvironment(env, multiProvider);
    const checker = new HyperlaneIgpChecker(multiProvider, igp, config.igp);
    governor = new HyperlaneIgpGovernor(checker, config.owners);
  } else if (module === Modules.INTERCHAIN_ACCOUNTS) {
    const routerConfig = await getRouterConfig(environment, multiProvider);
    const ica = InterchainAccount.fromEnvironment(env, multiProvider);
    const checker = new InterchainAccountChecker(
      multiProvider,
      ica,
      routerConfig,
    );
    governor = new ProxiedRouterGovernor(checker, config.owners);
  } else if (module === Modules.INTERCHAIN_QUERY_SYSTEM) {
    const routerConfig = await getRouterConfig(environment, multiProvider);
    const iqs = InterchainQuery.fromEnvironment(env, multiProvider);
    const checker = new InterchainQueryChecker(
      multiProvider,
      iqs,
      routerConfig,
    );
    governor = new ProxiedRouterGovernor(checker, config.owners);
  } else {
    console.log(`Skipping ${module}, checker or governor unimplemented`);
    return;
  }

  if (fork) {
    const onlyFork = fork[0];
    await governor.checker.checkChain(onlyFork.toString());
    if (govern) {
      await governor.govern(false, onlyFork.toString());
    }
  } else {
    await governor.checker.check();
    if (govern) {
      await governor.govern();
    }
  }

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
      console.info(`${module} Checker found no violations`);
    }
  }
}

check()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
