// import { providers } from 'ethers';
import path from 'path';

import {
  ChainMap,
  HyperlaneCoreDeployer,
  HyperlaneDeployer,
  HyperlaneHookDeployer,
  HyperlaneIgp,
  HyperlaneIgpDeployer,
  HyperlaneIsmFactory,
  HyperlaneIsmFactoryDeployer,
  InterchainAccountDeployer,
  InterchainQueryDeployer,
  LiquidityLayerDeployer,
  objMap,
} from '@hyperlane-xyz/sdk';

import { deployEnvToSdkEnv } from '../src/config/environment';
import { deployWithArtifacts } from '../src/deployment/deploy';
import { TestQuerySenderDeployer } from '../src/deployment/testcontracts/testquerysender';
import { TestRecipientDeployer } from '../src/deployment/testcontracts/testrecipient';
import { impersonateAccount, useLocalProvider } from '../src/utils/fork';
import { readJSON } from '../src/utils/utils';

import {
  Modules,
  SDK_MODULES,
  getArgs,
  getContractAddressesSdkFilepath,
  getEnvironmentConfig,
  getEnvironmentDirectory,
  getModuleDirectory,
  getRouterConfig,
  withModuleAndFork,
} from './utils';

async function main() {
  const { module, fork, environment } = await withModuleAndFork(getArgs()).argv;
  const envConfig = getEnvironmentConfig(environment);
  const multiProvider = await envConfig.getMultiProvider();

  if (fork) {
    await useLocalProvider(multiProvider, fork, 'localhost:8545');

    // TODO: make this more generic
    const deployerAddress =
      environment === 'testnet3'
        ? '0xfaD1C94469700833717Fa8a3017278BC1cA8031C'
        : '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba';

    const signer = await impersonateAccount(deployerAddress);
    multiProvider.setSigner(fork, signer);

    console.log('fork', fork);
  }

  let config: ChainMap<unknown> = {};
  let deployer: HyperlaneDeployer<any, any>;

  if (module === Modules.ISM_FACTORY) {
    config = objMap(envConfig.core, (chain) => true);
    deployer = new HyperlaneIsmFactoryDeployer(multiProvider);
  } else if (module === Modules.CORE) {
    config = envConfig.core;

    const ismFactory = HyperlaneIsmFactory.fromEnvironment(
      deployEnvToSdkEnv[environment],
      multiProvider,
    );
    deployer = new HyperlaneCoreDeployer(multiProvider, ismFactory);
  } else if (module === Modules.HOOK) {
    if (fork?.length !== 2) {
      throw new Error('fork must be a array of two forks');
    }

    await useLocalProvider(multiProvider, fork[0], 'http://127.0.0.1:8546');
    await useLocalProvider(multiProvider, fork[1], 'http://127.0.0.1:8547');

    const deployerAddress = '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba';
    const signer1 = await impersonateAccount(
      deployerAddress,
      'http://127.0.0.1:8546',
    );
    const signer2 = await impersonateAccount(
      deployerAddress,
      'http://127.0.0.1:8547',
    );

    multiProvider.setSigner(fork[0], signer1);
    multiProvider.setSigner(fork[1], signer2);

    // const newProvider = new MultiProvider();

    // // anvil --fork-url https://rpc.ankr.com/optimism --chain-id 31337 --port 8546
    // const ethForked = new providers.JsonRpcProvider('http://localhost:8546');
    // // anvil --fork-url https://rpc.ankr.com/optimism --chain-id 31337 --port 8547
    // const opForked = new providers.JsonRpcProvider('http://localhost:8547');

    // newProvider.setSigner(
    //   'ethereum',
    //   ethForked.getSigner('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'),
    // );
    // newProvider.setSigner(
    //   'optimism',
    //   opForked.getSigner('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'),
    // );

    if (!envConfig.hooks) {
      throw new Error(`No hook config for ${environment}`);
    }
    config = envConfig.hooks;

    config = {
      ethereum: {
        nativeType: 'hook',
        nativeBridge: '0x25ace71c97B33Cc4729CF772ae268934F7ab5fA1',
        remoteIsm: '0x4c5859f0f772848b2d91f1d83e2fe57935348029', // dummy
        destinationDomain: 10,
      },
      optimism: {
        nativeType: 'ism',
        nativeBridge: '0x4200000000000000000000000000000000000007',
      },
    };
    console.log('DEPLOY: config', config);

    deployer = new HyperlaneHookDeployer(multiProvider);
  } else if (module === Modules.INTERCHAIN_GAS_PAYMASTER) {
    config = envConfig.igp;
    deployer = new HyperlaneIgpDeployer(multiProvider);
  } else if (module === Modules.INTERCHAIN_ACCOUNTS) {
    config = await getRouterConfig(environment, multiProvider);
    deployer = new InterchainAccountDeployer(multiProvider);
  } else if (module === Modules.INTERCHAIN_QUERY_SYSTEM) {
    config = await getRouterConfig(environment, multiProvider);
    deployer = new InterchainQueryDeployer(multiProvider);
  } else if (module === Modules.LIQUIDITY_LAYER) {
    const routerConfig = await getRouterConfig(environment, multiProvider);
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
    // TODO: make this more generic
    const igp = HyperlaneIgp.fromEnvironment(
      deployEnvToSdkEnv[environment],
      multiProvider,
    );
    // Get query router addresses
    const queryRouterDir = path.join(
      getEnvironmentDirectory(environment),
      'middleware/queries',
    );
    config = objMap(readJSON(queryRouterDir, 'addresses.json'), (_c, conf) => ({
      queryRouterAddress: conf.router,
    }));
    deployer = new TestQuerySenderDeployer(multiProvider, igp);
  } else {
    console.log(`Skipping ${module}, deployer unimplemented`);
    return;
  }

  const modulePath = getModuleDirectory(environment, module);

  const addresses = SDK_MODULES.includes(module)
    ? path.join(
        getContractAddressesSdkFilepath(),
        `${deployEnvToSdkEnv[environment]}.json`,
      )
    : path.join(modulePath, 'addresses.json');

  console.log(
    `Deploying ${module} to ${environment} at path ${modulePath}, addresses ${addresses}`,
  );

  const verification = path.join(modulePath, 'verification.json');

  const cache = {
    addresses,
    verification,
    read: environment !== 'test',
    write: true,
  };
  // Don't write agent config in fork tests

  const agentConfig =
    ['core', 'igp'].includes(module) && !fork
      ? {
          addresses,
          environment,
          multiProvider,
        }
      : undefined;

  if (fork && fork[0]) {
    await deployWithArtifacts(
      config,
      deployer,
      cache,
      fork[0].toString(),
      agentConfig,
    );
  }
}

main()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
