import { HelloWorldChecker, HelloWorldConfig } from '@hyperlane-xyz/helloworld';
import {
  ChainMap,
  HyperlaneCore,
  HyperlaneCoreChecker,
  HyperlaneIgp,
  HyperlaneIgpChecker,
  HyperlaneIsmFactory,
  InterchainAccount,
  InterchainAccountChecker,
  InterchainQuery,
  InterchainQueryChecker,
} from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

import { aggregationIsm } from '../config/aggregationIsm';
import { Contexts } from '../config/contexts';
import {
  DeployEnvironment,
  deployEnvToSdkEnv,
} from '../src/config/environment';
import { HyperlaneAppGovernor } from '../src/govern/HyperlaneAppGovernor';
import { HyperlaneCoreGovernor } from '../src/govern/HyperlaneCoreGovernor';
import { HyperlaneIgpGovernor } from '../src/govern/HyperlaneIgpGovernor';
import { ProxiedRouterGovernor } from '../src/govern/ProxiedRouterGovernor';
import { Role } from '../src/roles';
import { impersonateAccount, useLocalProvider } from '../src/utils/fork';

import { getHelloWorldApp } from './helloworld/utils';
import {
  Modules,
  getEnvironmentConfig,
  getProxiedRouterConfig,
  getArgs as getRootArgs,
  getRouterConfig,
  withContext,
  withModuleAndFork,
} from './utils';

function getArgs() {
  return withModuleAndFork(withContext(getRootArgs()))
    .boolean('govern')
    .default('govern', false)
    .alias('g', 'govern').argv;
}

async function check() {
  const { fork, govern, module, environment, context } = await getArgs();
  const config = getEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();

  // must rotate to forked provider before building core contracts
  if (fork) {
    await useLocalProvider(multiProvider, fork);
    if (govern) {
      const owner = config.core[fork].owner;
      const signer = await impersonateAccount(owner);
      multiProvider.setSigner(fork, signer);
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
    const routerConfig = await getProxiedRouterConfig(
      environment,
      multiProvider,
    );
    const ica = InterchainAccount.fromEnvironment(env, multiProvider);
    const checker = new InterchainAccountChecker(
      multiProvider,
      ica,
      routerConfig,
    );
    governor = new ProxiedRouterGovernor(checker, config.owners);
  } else if (module === Modules.INTERCHAIN_QUERY_SYSTEM) {
    const routerConfig = await getProxiedRouterConfig(
      environment,
      multiProvider,
    );
    const iqs = InterchainQuery.fromEnvironment(env, multiProvider);
    const checker = new InterchainQueryChecker(
      multiProvider,
      iqs,
      routerConfig,
    );
    governor = new ProxiedRouterGovernor(checker, config.owners);
  } else if (module === Modules.HELLO_WORLD) {
    console.log('check.ts a');
    const app = await getHelloWorldApp(
      config,
      context,
      Role.Deployer,
      Contexts.Hyperlane, // Owner should always be from the hyperlane context
    );
    console.log('check.ts b');
    const configMap = await getRouterConfig(environment, multiProvider, true);
    console.log('configMap', configMap);
    const hwConfig = helloWorldConfig(environment, context, configMap);
    console.log('config', config);
    console.log('hwConfig', hwConfig);
    console.log(
      'hwConfig.fuji.interchainSecurityModule',
      JSON.stringify(hwConfig.fuji.interchainSecurityModule),
      hwConfig.fuji.interchainSecurityModule,
    );
    const ismFactory = HyperlaneIsmFactory.fromEnvironment(
      deployEnvToSdkEnv[environment],
      multiProvider,
    );
    const checker = new HelloWorldChecker(
      multiProvider,
      app,
      hwConfig,
      ismFactory,
    );
    governor = new ProxiedRouterGovernor(checker, config.owners);
  } else {
    console.log(`Skipping ${module}, checker or governor unimplemented`);
    return;
  }

  if (fork) {
    await governor.checker.checkChain(fork);
    if (govern) {
      await governor.govern(false, fork);
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
      if (!fork) {
        throw new Error(
          `Checking ${module} deploy yielded ${violations.length} violations`,
        );
      }
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

export const helloWorldConfig = (
  environment: DeployEnvironment,
  context: Contexts,
  configMap: ChainMap<HelloWorldConfig>,
): ChainMap<HelloWorldConfig> =>
  objMap(configMap, (chain, config) => ({
    ...config,
    interchainSecurityModule:
      context === Contexts.Hyperlane
        ? undefined
        : aggregationIsm(environment, chain, context),
  }));
