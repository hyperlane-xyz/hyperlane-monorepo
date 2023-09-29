import path from 'path';

import { HelloWorldDeployer } from '@hyperlane-xyz/helloworld';
import {
  ChainMap,
  HyperlaneCoreDeployer,
  HyperlaneDeployer,
  HyperlaneIgpDeployer,
  HyperlaneIsmFactory,
  HyperlaneIsmFactoryDeployer,
  InterchainAccountDeployer,
  InterchainQueryDeployer,
  LiquidityLayerDeployer,
  MerkleRootInterceptorDeployer,
} from '@hyperlane-xyz/sdk';
import { Address, objMap } from '@hyperlane-xyz/utils';

import { Contexts } from '../config/contexts';
import {
  DeployEnvironment,
  deployEnvToSdkEnv,
} from '../src/config/environment';
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
  getProxiedRouterConfig,
  getRouterConfig,
  withContext,
  withModuleAndFork,
} from './utils';

async function main() {
  const {
    context = Contexts.Hyperlane,
    module,
    fork,
    environment,
  } = await withContext(withModuleAndFork(getArgs())).argv;
  const envConfig = getEnvironmentConfig(environment);
  const multiProvider = await envConfig.getMultiProvider();

  if (fork) {
    await useLocalProvider(multiProvider, fork);

    // TODO: make this more generic
    const deployerAddress =
      environment === 'testnet3'
        ? '0xfaD1C94469700833717Fa8a3017278BC1cA8031C'
        : '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba';

    const signer = await impersonateAccount(deployerAddress);
    multiProvider.setSharedSigner(signer);
  }

  let config: ChainMap<unknown> = {};
  let deployer: HyperlaneDeployer<any, any>;
  if (module === Modules.ISM_FACTORY) {
    config = objMap(envConfig.core, (_chain) => true);
    deployer = new HyperlaneIsmFactoryDeployer(multiProvider);
  } else if (module === Modules.CORE) {
    config = envConfig.core;
    const ismFactory = HyperlaneIsmFactory.fromAddressesMap(
      getAddresses(environment, Modules.ISM_FACTORY),
      multiProvider,
    );
    deployer = new HyperlaneCoreDeployer(multiProvider, ismFactory);
  } else if (module === Modules.HOOK) {
    if (!envConfig.interceptor) {
      throw new Error(`No hook config for ${environment}`);
    }
    config = envConfig.interceptor;
    const ismFactory = HyperlaneIsmFactory.fromAddressesMap(
      getAddresses(environment, Modules.ISM_FACTORY),
      multiProvider,
    );
    const mailboxes: ChainMap<Address> = {};
    for (const chain in getAddresses(environment, Modules.CORE)) {
      mailboxes[chain] = getAddresses(environment, Modules.CORE)[chain].mailbox;
    }

    deployer = new MerkleRootInterceptorDeployer(
      multiProvider,
      ismFactory,
      mailboxes,
    );
  } else if (module === Modules.INTERCHAIN_GAS_PAYMASTER) {
    config = envConfig.igp;
    deployer = new HyperlaneIgpDeployer(multiProvider);
  } else if (module === Modules.INTERCHAIN_ACCOUNTS) {
    config = await getProxiedRouterConfig(environment, multiProvider);
    deployer = new InterchainAccountDeployer(multiProvider);
  } else if (module === Modules.INTERCHAIN_QUERY_SYSTEM) {
    config = await getProxiedRouterConfig(environment, multiProvider);
    deployer = new InterchainQueryDeployer(multiProvider);
  } else if (module === Modules.LIQUIDITY_LAYER) {
    const routerConfig = await getProxiedRouterConfig(
      environment,
      multiProvider,
    );
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
    config = await getRouterConfig(
      environment,
      multiProvider,
      true, // use deployer as owner
    );
    const ismFactory = HyperlaneIsmFactory.fromAddressesMap(
      getAddresses(environment, Modules.ISM_FACTORY),
      multiProvider,
    );
    deployer = new HelloWorldDeployer(multiProvider, ismFactory);
  } else {
    console.log(`Skipping ${module}, deployer unimplemented`);
    return;
  }

  const { modulePath, addresses } = getModulePathAndAddressesPath(
    environment,
    module,
    context,
  );

  console.log(`Deploying to ${modulePath}`);

  const verification = path.join(modulePath, 'verification.json');

  const cache = {
    addresses,
    verification,
    read: environment !== 'test',
    write: true,
  };
  const agentConfigModules: Array<Modules> = [
    Modules.CORE,
    Modules.INTERCHAIN_GAS_PAYMASTER,
  ];
  // Don't write agent config in fork tests
  const agentConfig =
    agentConfigModules.includes(module) && !fork
      ? {
          addresses,
          environment,
          multiProvider,
          agentConfigModuleAddressPaths: agentConfigModules.map(
            (m) =>
              getModulePathAndAddressesPath(environment, m, context).addresses,
          ),
        }
      : undefined;

  await deployWithArtifacts(config, deployer, cache, fork, agentConfig);
}

function getModulePathAndAddressesPath(
  environment: DeployEnvironment,
  module: Modules,
  context: Contexts,
) {
  const modulePath = getModuleDirectory(environment, module, context);

  const isSdkArtifact = SDK_MODULES.includes(module) && environment !== 'test';

  const addresses = isSdkArtifact
    ? path.join(
        getContractAddressesSdkFilepath(),
        `${deployEnvToSdkEnv[environment]}.json`,
      )
    : path.join(modulePath, 'addresses.json');

  return { modulePath, addresses };
}

main()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
