import { HelloWorldChecker } from '@hyperlane-xyz/helloworld';
import {
  HypERC20App,
  HypERC20Checker,
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

import { Contexts } from '../config/contexts';
import { deployEnvToSdkEnv } from '../src/config/environment';
import { HyperlaneAppGovernor } from '../src/govern/HyperlaneAppGovernor';
import { HyperlaneCoreGovernor } from '../src/govern/HyperlaneCoreGovernor';
import { HyperlaneIgpGovernor } from '../src/govern/HyperlaneIgpGovernor';
import { ProxiedRouterGovernor } from '../src/govern/ProxiedRouterGovernor';
import { Role } from '../src/roles';
import { impersonateAccount, useLocalProvider } from '../src/utils/fork';
import { readJSONAtPath } from '../src/utils/utils';

import {
  Modules,
  getArgs as getRootArgs,
  withConfigAndArtifactPath,
  withContext,
  withModuleAndFork,
} from './agent-utils';
import { getEnvironmentConfig } from './core-utils';
import { getHelloWorldApp } from './helloworld/utils';

function getArgs() {
  return withConfigAndArtifactPath(
    withModuleAndFork(withContext(getRootArgs())),
  )
    .boolean('govern')
    .default('govern', false)
    .alias('g', 'govern').argv;
}

async function check() {
  const {
    fork,
    govern,
    module,
    environment,
    context,
    artifactPath,
    configPath,
  } = await getArgs();
  const config = getEnvironmentConfig(environment);
  let multiProvider = await config.getMultiProvider();

  // must rotate to forked provider before building core contracts
  if (fork) {
    await useLocalProvider(multiProvider, fork);

    if (govern) {
      multiProvider = multiProvider.extendChainMetadata({
        [fork]: { blocks: { confirmations: 0 } },
      });

      const owner = config.core[fork].owner;
      const signer = await impersonateAccount(owner, 1e18);

      multiProvider.setSigner(fork, signer);
    }
  }

  const env = deployEnvToSdkEnv[environment];
  const core = HyperlaneCore.fromEnvironment(env, multiProvider);
  const ismFactory = HyperlaneIsmFactory.fromEnvironment(env, multiProvider);
  const routerConfig = core.getRouterConfig(config.owners);

  let governor: HyperlaneAppGovernor<any, any>;
  if (module === Modules.CORE) {
    const checker = new HyperlaneCoreChecker(
      multiProvider,
      core,
      config.core,
      ismFactory,
    );
    governor = new HyperlaneCoreGovernor(checker);
  } else if (module === Modules.INTERCHAIN_GAS_PAYMASTER) {
    const igp = HyperlaneIgp.fromEnvironment(env, multiProvider);
    const checker = new HyperlaneIgpChecker(multiProvider, igp, config.igp);
    governor = new HyperlaneIgpGovernor(checker);
  } else if (module === Modules.INTERCHAIN_ACCOUNTS) {
    const ica = InterchainAccount.fromEnvironment(env, multiProvider);
    const checker = new InterchainAccountChecker(
      multiProvider,
      ica,
      routerConfig,
    );
    governor = new ProxiedRouterGovernor(checker);
  } else if (module === Modules.INTERCHAIN_QUERY_SYSTEM) {
    const iqs = InterchainQuery.fromEnvironment(env, multiProvider);
    const checker = new InterchainQueryChecker(
      multiProvider,
      iqs,
      routerConfig,
    );
    governor = new ProxiedRouterGovernor(checker);
  } else if (module === Modules.HELLO_WORLD) {
    const app = await getHelloWorldApp(
      config,
      context,
      Role.Deployer,
      Contexts.Hyperlane, // Owner should always be from the hyperlane context
    );
    const ismFactory = HyperlaneIsmFactory.fromEnvironment(env, multiProvider);
    const checker = new HelloWorldChecker(
      multiProvider,
      app,
      routerConfig,
      ismFactory,
    );
    governor = new ProxiedRouterGovernor(checker);
  } else if (module === Modules.WARP) {
    if (!artifactPath || !configPath) {
      throw new Error('artifactPath and configPath are required for WARP');
    }
    const artifacts = readJSONAtPath(artifactPath);
    const config = readJSONAtPath(configPath);

    const app = HypERC20App.fromAddressesMap(artifacts, multiProvider);
    const checker = new HypERC20Checker(multiProvider, app, config);
    governor = new ProxiedRouterGovernor(checker);
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
