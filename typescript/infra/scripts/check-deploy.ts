import { HelloWorldChecker } from '@hyperlane-xyz/helloworld';
import {
  HypERC20App,
  HypERC20Checker,
  HyperlaneCoreChecker,
  HyperlaneIgp,
  HyperlaneIgpChecker,
  HyperlaneIsmFactory,
  InterchainAccount,
  InterchainAccountChecker,
  InterchainQuery,
  InterchainQueryChecker,
  resolveOrDeployAccountOwner,
} from '@hyperlane-xyz/sdk';

import { Contexts } from '../config/contexts.js';
import { getWarpConfig } from '../config/warp.js';
import { HyperlaneAppGovernor } from '../src/govern/HyperlaneAppGovernor.js';
import { HyperlaneCoreGovernor } from '../src/govern/HyperlaneCoreGovernor.js';
import { HyperlaneIgpGovernor } from '../src/govern/HyperlaneIgpGovernor.js';
import { ProxiedRouterGovernor } from '../src/govern/ProxiedRouterGovernor.js';
import { Role } from '../src/roles.js';
import { impersonateAccount, useLocalProvider } from '../src/utils/fork.js';

import {
  Modules,
  getAddresses,
  getArgs as getRootArgs,
  withChain,
  withContext,
  withModuleAndFork,
} from './agent-utils.js';
import { getEnvironmentConfig, getHyperlaneCore } from './core-utils.js';
import { getHelloWorldApp } from './helloworld/utils.js';

function getArgs() {
  return withChain(withModuleAndFork(withContext(getRootArgs())))
    .boolean('govern')
    .default('govern', false)
    .alias('g', 'govern').argv;
}

async function check() {
  const { fork, govern, module, environment, context, chain } = await getArgs();
  const envConfig = getEnvironmentConfig(environment);
  let multiProvider = await envConfig.getMultiProvider();

  // must rotate to forked provider before building core contracts
  if (fork) {
    await useLocalProvider(multiProvider, fork);

    if (govern) {
      multiProvider = multiProvider.extendChainMetadata({
        [fork]: { blocks: { confirmations: 0 } },
      });

      const owner = await resolveOrDeployAccountOwner(
        multiProvider,
        fork,
        envConfig.core[fork].owner,
      );
      const signer = await impersonateAccount(owner, 1e18);

      multiProvider.setSigner(fork, signer);
    }
  }

  const { core, chainAddresses } = await getHyperlaneCore(
    environment,
    multiProvider,
  );
  const ismFactory = HyperlaneIsmFactory.fromAddressesMap(
    chainAddresses,
    multiProvider,
  );
  const routerConfig = core.getRouterConfig(envConfig.owners);
  const ica = InterchainAccount.fromAddressesMap(chainAddresses, multiProvider);

  let governor: HyperlaneAppGovernor<any, any>;
  if (module === Modules.CORE) {
    const checker = new HyperlaneCoreChecker(
      multiProvider,
      core,
      envConfig.core,
      ismFactory,
    );
    governor = new HyperlaneCoreGovernor(checker);
  } else if (module === Modules.INTERCHAIN_GAS_PAYMASTER) {
    const igp = HyperlaneIgp.fromAddressesMap(chainAddresses, multiProvider);
    const checker = new HyperlaneIgpChecker(multiProvider, igp, envConfig.igp);
    governor = new HyperlaneIgpGovernor(checker);
  } else if (module === Modules.INTERCHAIN_ACCOUNTS) {
    const checker = new InterchainAccountChecker(
      multiProvider,
      ica,
      routerConfig,
    );
    governor = new ProxiedRouterGovernor(checker);
  } else if (module === Modules.INTERCHAIN_QUERY_SYSTEM) {
    const iqs = InterchainQuery.fromAddressesMap(chainAddresses, multiProvider);
    const checker = new InterchainQueryChecker(
      multiProvider,
      iqs,
      routerConfig,
    );
    governor = new ProxiedRouterGovernor(checker);
  } else if (module === Modules.HELLO_WORLD) {
    const app = await getHelloWorldApp(
      envConfig,
      context,
      Role.Deployer,
      Contexts.Hyperlane, // Owner should always be from the hyperlane context
    );
    const ismFactory = HyperlaneIsmFactory.fromAddressesMap(
      chainAddresses,
      multiProvider,
    );
    const checker = new HelloWorldChecker(
      multiProvider,
      app,
      routerConfig,
      ismFactory,
    );
    governor = new ProxiedRouterGovernor(checker);
  } else if (module === Modules.WARP) {
    const config = await getWarpConfig(multiProvider, envConfig);
    const addresses = getAddresses(environment, Modules.WARP);
    const filteredAddresses = Object.keys(addresses) // filter out changes not in config
      .filter((key) => key in config)
      .reduce((obj, key) => {
        obj[key] = addresses[key];
        return obj;
      }, {} as typeof addresses);
    const app = HypERC20App.fromAddressesMap(filteredAddresses, multiProvider);

    const checker = new HypERC20Checker(
      multiProvider,
      app,
      config as any,
      ismFactory,
    );
    governor = new ProxiedRouterGovernor(checker, ica);
  } else {
    console.log(`Skipping ${module}, checker or governor unimplemented`);
    return;
  }

  if (fork) {
    await governor.checker.checkChain(fork);
    if (govern) {
      await governor.govern(false, fork);
    }
  } else if (chain) {
    await governor.checker.checkChain(chain);
    if (govern) {
      await governor.govern(true, chain);
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
