import { ethers } from 'ethers';

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
  TokenType,
  resolveOrDeployAccountOwner,
} from '@hyperlane-xyz/sdk';

import { Contexts } from '../config/contexts.js';
import { DEPLOYER } from '../config/environments/mainnet3/owners.js';
import { deployEnvToSdkEnv } from '../src/config/environment.js';
import { tokens } from '../src/config/warp.js';
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
  withContext,
  withModuleAndFork,
} from './agent-utils.js';
import { getEnvironmentConfig } from './core-utils.js';
import { getHelloWorldApp } from './helloworld/utils.js';

function getArgs() {
  return withModuleAndFork(withContext(getRootArgs()))
    .boolean('govern')
    .default('govern', false)
    .alias('g', 'govern').argv;
}

async function check() {
  const { fork, govern, module, environment, context } = await getArgs();
  const config = getEnvironmentConfig(environment);
  let multiProvider = await config.getMultiProvider();

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
        config.core[fork].owner,
      );
      const signer = await impersonateAccount(owner, 1e18);

      multiProvider.setSigner(fork, signer);
    }
  }

  const env = deployEnvToSdkEnv[environment];
  const core = HyperlaneCore.fromEnvironment(env, multiProvider);
  const ismFactory = HyperlaneIsmFactory.fromEnvironment(env, multiProvider);
  const routerConfig = core.getRouterConfig(config.owners);
  const ica = InterchainAccount.fromEnvironment(env, multiProvider);

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
    // test config
    const ethereum = {
      ...routerConfig.ethereum,
      type: TokenType.collateral,
      token: tokens.ethereum.USDC,
      // Really, this should be an object config from something like:
      //   buildAggregationIsmConfigs(
      //     'ethereum',
      //     ['ancient8'],
      //     defaultMultisigConfigs,
      //   ).ancient8
      // However ISM objects are no longer able to be passed directly to the warp route
      // deployer. As a temporary workaround, I'm using an ISM address from a previous
      // ethereum <> ancient8 warp route deployment:
      //   $ cast call 0x9f5cF636b4F2DC6D83c9d21c8911876C235DbC9f 'interchainSecurityModule()(address)' --rpc-url https://rpc.ankr.com/eth
      //   0xD17B4100cC66A2F1B9a452007ff26365aaeB7EC3
      interchainSecurityModule: '0xD17B4100cC66A2F1B9a452007ff26365aaeB7EC3',
      // This hook was recovered from running the deploy script
      // for the hook module. The hook configuration is the Ethereum
      // default hook for the Ancient8 remote (no routing).
      hook: '0x19b2cF952b70b217c90FC408714Fbc1acD29A6A8',
      owner: DEPLOYER,
    };
    const ancient8 = {
      ...routerConfig.ancient8,
      type: TokenType.synthetic,
      name: 'USD Coin',
      symbol: 'USDC',
      decimals: 6,
      // Uses the default ISM
      interchainSecurityModule: ethers.constants.AddressZero,
      owner: DEPLOYER,
    };

    const config = {
      ethereum,
      ancient8,
    };
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
