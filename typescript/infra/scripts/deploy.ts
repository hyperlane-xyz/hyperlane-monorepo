import path from 'path';
import { prompt } from 'prompts';

import { HelloWorldDeployer } from '@hyperlane-xyz/helloworld';
import {
  ChainMap,
  HypERC20Deployer,
  HyperlaneCore,
  HyperlaneCoreDeployer,
  HyperlaneDeployer,
  HyperlaneIgpDeployer,
  HyperlaneIsmFactory,
  HyperlaneProxyFactoryDeployer,
  InterchainAccountDeployer,
  InterchainQueryDeployer,
  LiquidityLayerDeployer,
} from '@hyperlane-xyz/sdk';
import {
  HypERC20CollateralConfig,
  HypERC20Config,
  TokenType,
} from '@hyperlane-xyz/sdk/dist/token/config';
import { objMap } from '@hyperlane-xyz/utils';

import { Contexts } from '../config/contexts';
import { aggregationIsm } from '../config/routingIsm';
import { deployEnvToSdkEnv } from '../src/config/environment';
import { deployWithArtifacts } from '../src/deployment/deploy';
import { TestQuerySenderDeployer } from '../src/deployment/testcontracts/testquerysender';
import { TestRecipientDeployer } from '../src/deployment/testcontracts/testrecipient';
import { impersonateAccount, useLocalProvider } from '../src/utils/fork';

import {
  Modules,
  SDK_MODULES,
  getAddresses,
  getArgs,
  getContractAddressesSdkFilepath,
  getEnvironmentConfig,
  getModuleDirectory,
  withContext,
  withModuleAndFork,
  withNetwork,
} from './utils';

async function main() {
  const {
    context = Contexts.Hyperlane,
    module,
    fork,
    environment,
    network,
  } = await withContext(withNetwork(withModuleAndFork(getArgs()))).argv;
  const envConfig = getEnvironmentConfig(environment);
  const env = deployEnvToSdkEnv[environment];

  let multiProvider = await envConfig.getMultiProvider();

  // TODO: make this more generic
  const deployerAddress =
    environment === 'testnet4'
      ? '0xfaD1C94469700833717Fa8a3017278BC1cA8031C'
      : '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba';

  if (fork) {
    multiProvider = multiProvider.extendChainMetadata({
      [fork]: { blocks: { confirmations: 0 } },
    });
    await useLocalProvider(multiProvider, fork);

    const signer = await impersonateAccount(deployerAddress);
    multiProvider.setSharedSigner(signer);
  }

  let config: ChainMap<unknown> = {};
  let deployer: HyperlaneDeployer<any, any>;
  if (module === Modules.PROXY_FACTORY) {
    config = objMap(envConfig.core, (_chain) => true);
    deployer = new HyperlaneProxyFactoryDeployer(multiProvider);
  } else if (module === Modules.CORE) {
    config = envConfig.core;
    const ismFactory = HyperlaneIsmFactory.fromAddressesMap(
      getAddresses(environment, Modules.PROXY_FACTORY),
      multiProvider,
    );
    deployer = new HyperlaneCoreDeployer(multiProvider, ismFactory);
  } else if (module === Modules.WARP) {
    const owner = deployerAddress;
    const ismFactory = HyperlaneIsmFactory.fromAddressesMap(
      getAddresses(environment, Modules.PROXY_FACTORY),
      multiProvider,
    );
    const core = HyperlaneCore.fromEnvironment(
      deployEnvToSdkEnv[environment],
      multiProvider,
    );
    const routerConfig = core.getRouterConfig(owner);
    const syntheticConfig: HypERC20Config = {
      type: TokenType.synthetic,
      name: 'USDT',
      symbol: 'USDT',
      decimals: 6,
      totalSupply: 0,
      gas: 75_000, // collateral overhead
      ...routerConfig['viction'],
    };
    const collateralConfig: HypERC20CollateralConfig = {
      type: TokenType.collateral,
      token: '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
      gas: 65_000, // synthetic overhead
      ...routerConfig['ethereum'],
      interchainSecurityModule: aggregationIsm('viction', Contexts.Hyperlane),
    };
    config = {
      viction: syntheticConfig,
      ethereum: collateralConfig,
    };
    deployer = new HypERC20Deployer(multiProvider, ismFactory);
  } else if (module === Modules.INTERCHAIN_GAS_PAYMASTER) {
    config = envConfig.igp;
    deployer = new HyperlaneIgpDeployer(multiProvider);
  } else if (module === Modules.INTERCHAIN_ACCOUNTS) {
    const core = HyperlaneCore.fromEnvironment(env, multiProvider);
    config = core.getRouterConfig(envConfig.owners);
    deployer = new InterchainAccountDeployer(multiProvider);
  } else if (module === Modules.INTERCHAIN_QUERY_SYSTEM) {
    const core = HyperlaneCore.fromEnvironment(env, multiProvider);
    config = core.getRouterConfig(envConfig.owners);
    deployer = new InterchainQueryDeployer(multiProvider);
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
    deployer = new LiquidityLayerDeployer(multiProvider);
  } else if (module === Modules.TEST_RECIPIENT) {
    config = objMap(envConfig.core, (_chain) => true);
    deployer = new TestRecipientDeployer(multiProvider);
  } else if (module === Modules.TEST_QUERY_SENDER) {
    // Get query router addresses
    const queryAddresses = getAddresses(
      environment,
      Modules.INTERCHAIN_QUERY_SYSTEM,
    );
    config = objMap(queryAddresses, (_c, conf) => ({
      queryRouterAddress: conf.router,
    }));
    deployer = new TestQuerySenderDeployer(multiProvider);
  } else if (module === Modules.HELLO_WORLD) {
    const core = HyperlaneCore.fromEnvironment(env, multiProvider);
    config = core.getRouterConfig(deployerAddress);
    deployer = new HelloWorldDeployer(multiProvider);
  } else {
    console.log(`Skipping ${module}, deployer unimplemented`);
    return;
  }

  const modulePath = getModuleDirectory(environment, module, context);

  console.log(`Deploying to ${modulePath}`);

  const isSdkArtifact = SDK_MODULES.includes(module) && environment !== 'test';

  const addresses = isSdkArtifact
    ? path.join(
        getContractAddressesSdkFilepath(),
        `${deployEnvToSdkEnv[environment]}.json`,
      )
    : path.join(modulePath, 'addresses.json');

  const verification = path.join(modulePath, 'verification.json');

  const cache = {
    addresses,
    verification,
    read: environment !== 'test',
    write: true,
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

  // prompt for confirmation
  if ((environment === 'mainnet3' || environment === 'testnet4') && !fork) {
    let confirmConfig = network ? config[network] : config;
    console.log(JSON.stringify(confirmConfig, null, 2));
    const { value: confirmed } = await prompt({
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
