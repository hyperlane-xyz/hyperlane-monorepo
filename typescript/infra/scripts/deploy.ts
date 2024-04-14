import { ethers } from 'ethers';
import path from 'path';
import prompts from 'prompts';

import { HelloWorldDeployer } from '@hyperlane-xyz/helloworld';
import {
  ChainMap,
  ContractVerifier,
  ExplorerLicenseType,
  FallbackRoutingHookConfig,
  HypERC20Deployer,
  HyperlaneCore,
  HyperlaneCoreDeployer,
  HyperlaneDeployer,
  HyperlaneHookDeployer,
  HyperlaneIgpDeployer,
  HyperlaneIsmFactory,
  HyperlaneProxyFactoryDeployer,
  InterchainAccount,
  InterchainAccountDeployer,
  InterchainQueryDeployer,
  LiquidityLayerDeployer,
  TestRecipientDeployer,
  TokenType,
  hyperlaneEnvironments,
} from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

import { Contexts } from '../config/contexts.js';
import { core as coreConfig } from '../config/environments/mainnet3/core.js';
import { DEPLOYER } from '../config/environments/mainnet3/owners.js';
import { deployEnvToSdkEnv } from '../src/config/environment.js';
import { tokens } from '../src/config/warp.js';
import { deployWithArtifacts } from '../src/deployment/deploy.js';
import { TestQuerySenderDeployer } from '../src/deployment/testcontracts/testquerysender.js';
import {
  extractBuildArtifact,
  fetchExplorerApiKeys,
} from '../src/deployment/verify.js';
import { impersonateAccount, useLocalProvider } from '../src/utils/fork.js';

import {
  Modules,
  getAddresses,
  getAddressesPath,
  getArgs,
  getModuleDirectory,
  withBuildArtifactPath,
  withContext,
  withModuleAndFork,
  withNetwork,
} from './agent-utils.js';
import { getEnvironmentConfig } from './core-utils.js';

async function main() {
  const {
    context = Contexts.Hyperlane,
    module,
    fork,
    environment,
    network,
    buildArtifactPath,
  } = await withContext(
    withNetwork(withModuleAndFork(withBuildArtifactPath(getArgs()))),
  ).argv;
  const envConfig = getEnvironmentConfig(environment);
  const env = deployEnvToSdkEnv[environment];

  let multiProvider = await envConfig.getMultiProvider();

  if (fork) {
    multiProvider = multiProvider.extendChainMetadata({
      [fork]: { blocks: { confirmations: 0 } },
    });
    await useLocalProvider(multiProvider, fork);

    // const deployers = await envConfig.getKeys(
    //   Contexts.Hyperlane,
    //   Role.Deployer,
    // );
    // const deployer = deployers[fork].address;
    const deployer = '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba';
    const signer = await impersonateAccount(deployer);

    multiProvider.setSharedSigner(signer);
  }

  let contractVerifier;
  if (buildArtifactPath) {
    // fetch explorer API keys from GCP
    const apiKeys = await fetchExplorerApiKeys();
    // extract build artifact contents
    const buildArtifact = extractBuildArtifact(buildArtifactPath);
    // instantiate verifier
    contractVerifier = new ContractVerifier(
      multiProvider,
      apiKeys,
      buildArtifact,
      ExplorerLicenseType.MIT,
    );
  }

  let config: ChainMap<unknown> = {};
  let deployer: HyperlaneDeployer<any, any>;
  if (module === Modules.PROXY_FACTORY) {
    config = objMap(envConfig.core, (_chain) => true);
    deployer = new HyperlaneProxyFactoryDeployer(
      multiProvider,
      contractVerifier,
    );
  } else if (module === Modules.CORE) {
    config = envConfig.core;
    const ismFactory = HyperlaneIsmFactory.fromAddressesMap(
      getAddresses(environment, Modules.PROXY_FACTORY),
      multiProvider,
    );
    deployer = new HyperlaneCoreDeployer(
      multiProvider,
      ismFactory,
      contractVerifier,
    );
  } else if (module === Modules.WARP) {
    const core = HyperlaneCore.fromEnvironment(env, multiProvider);
    const ismFactory = HyperlaneIsmFactory.fromAddressesMap(
      getAddresses(environment, Modules.PROXY_FACTORY),
      multiProvider,
    );
    const routerConfig = core.getRouterConfig(envConfig.owners);

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
      // Uses the default ISM
      interchainSecurityModule: ethers.constants.AddressZero,
      owner: DEPLOYER,
    };

    config = {
      ethereum,
      ancient8,
    };
    deployer = new HypERC20Deployer(
      multiProvider,
      ismFactory,
      contractVerifier,
    );
  } else if (module === Modules.INTERCHAIN_GAS_PAYMASTER) {
    config = envConfig.igp;
    deployer = new HyperlaneIgpDeployer(multiProvider, contractVerifier);
  } else if (module === Modules.INTERCHAIN_ACCOUNTS) {
    const core = HyperlaneCore.fromEnvironment(env, multiProvider);
    config = core.getRouterConfig(envConfig.owners);
    deployer = new InterchainAccountDeployer(multiProvider, contractVerifier);
    const addresses = getAddresses(environment, Modules.INTERCHAIN_ACCOUNTS);
    InterchainAccount.fromAddressesMap(addresses, multiProvider);
  } else if (module === Modules.INTERCHAIN_QUERY_SYSTEM) {
    const core = HyperlaneCore.fromEnvironment(env, multiProvider);
    config = core.getRouterConfig(envConfig.owners);
    deployer = new InterchainQueryDeployer(multiProvider, contractVerifier);
  } else if (module === Modules.LIQUIDITY_LAYER) {
    const core = HyperlaneCore.fromEnvironment(env, multiProvider);
    const routerConfig = core.getRouterConfig(envConfig.owners);
    if (!envConfig.liquidityLayerConfig) {
      throw new Error(`No liquidity layer config for ${environment}`);
    }
    config = objMap(
      envConfig.liquidityLayerConfig.bridgeAdapters,
      (chain, conf) => ({
        ...conf,
        ...routerConfig[chain],
      }),
    );
    deployer = new LiquidityLayerDeployer(multiProvider, contractVerifier);
  } else if (module === Modules.TEST_RECIPIENT) {
    const addresses = getAddresses(environment, Modules.CORE);

    for (const chain of Object.keys(addresses)) {
      config[chain] = {
        interchainSecurityModule:
          addresses[chain].interchainSecurityModule ??
          ethers.constants.AddressZero, // ISM is required for the TestRecipientDeployer but onchain if the ISM is zero address, then it uses the mailbox's defaultISM
      };
    }
    deployer = new TestRecipientDeployer(multiProvider, contractVerifier);
  } else if (module === Modules.TEST_QUERY_SENDER) {
    // Get query router addresses
    const queryAddresses = getAddresses(
      environment,
      Modules.INTERCHAIN_QUERY_SYSTEM,
    );
    config = objMap(queryAddresses, (_c, conf) => ({
      queryRouterAddress: conf.router,
    }));
    deployer = new TestQuerySenderDeployer(multiProvider, contractVerifier);
  } else if (module === Modules.HELLO_WORLD) {
    const core = HyperlaneCore.fromEnvironment(env, multiProvider);
    config = core.getRouterConfig(envConfig.owners);
    deployer = new HelloWorldDeployer(
      multiProvider,
      undefined,
      contractVerifier,
    );
  } else if (module === Modules.HOOK) {
    const ismFactory = HyperlaneIsmFactory.fromAddressesMap(
      getAddresses(environment, Modules.PROXY_FACTORY),
      multiProvider,
    );
    deployer = new HyperlaneHookDeployer(
      multiProvider,
      hyperlaneEnvironments[env],
      ismFactory,
    );
    // Config is intended to be changed for ad-hoc use cases:
    config = {
      ethereum: {
        ...(coreConfig.ethereum.defaultHook as FallbackRoutingHookConfig)
          .domains.ancient8,
        owner: DEPLOYER,
      },
    };
  } else {
    console.log(`Skipping ${module}, deployer unimplemented`);
    return;
  }

  const modulePath = getModuleDirectory(environment, module, context);

  console.log(`Deploying to ${modulePath}`);

  const addresses = getAddressesPath(environment, module);
  const verification = path.join(modulePath, 'verification.json');

  const cache = {
    addresses,
    verification,
    read: environment !== 'test',
    write: !fork,
  };
  // Don't write agent config in fork tests
  const agentConfig =
    module === Modules.CORE && !fork
      ? {
          addresses,
          environment,
          multiProvider,
        }
      : undefined;

  // prompt for confirmation in production environments
  if (environment !== 'test' && !fork) {
    const confirmConfig = network ? config[network] : config;
    console.log(JSON.stringify(confirmConfig, null, 2));
    const { value: confirmed } = await prompts({
      type: 'confirm',
      name: 'value',
      message: `Confirm you want to deploy this ${module} configuration to ${environment}?`,
      initial: false,
    });
    if (!confirmed) {
      process.exit(0);
    }
  }

  await deployWithArtifacts(
    config,
    deployer,
    cache,
    network ?? fork,
    agentConfig,
  );
}

main()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
