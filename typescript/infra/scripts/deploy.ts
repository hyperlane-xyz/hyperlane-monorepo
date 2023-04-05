import path from 'path';

import {
  HyperlaneCoreDeployer,
  HyperlaneDeployer,
  HyperlaneIgp,
  HyperlaneIgpDeployer,
  InterchainAccountDeployer,
  InterchainQueryDeployer,
  LiquidityLayerDeployer,
  objMap,
} from '@hyperlane-xyz/sdk';

import { bridgeAdapterConfigs } from '../config/environments/test/liquidityLayer';
import { deployEnvToSdkEnv } from '../src/config/environment';
import { Create2FactoryDeployer } from '../src/create2';
import { deployWithArtifacts } from '../src/deploy';
import { TestQuerySenderDeployer } from '../src/testcontracts/testquerysender';
import { TestRecipientDeployer } from '../src/testcontracts/testrecipient';
import { impersonateAccount, useLocalProvider } from '../src/utils/fork';
import { readJSON } from '../src/utils/utils';

import {
  Modules,
  SDK_MODULES,
  getArgsWithModuleAndFork,
  getContractAddressesSdkFilepath,
  getEnvironmentConfig,
  getEnvironmentDirectory,
  getModuleDirectory,
  getRouterConfig,
} from './utils';

async function main() {
  const { module, fork, environment } = await getArgsWithModuleAndFork().argv;
  const envConfig = await getEnvironmentConfig(environment);
  const multiProvider = await envConfig.getMultiProvider();

  if (fork) {
    await useLocalProvider(multiProvider, fork);

    // TODO: make this more generic
    const deployerAddress =
      environment === 'testnet3'
        ? '0xfaD1C94469700833717Fa8a3017278BC1cA8031C'
        : '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba';

    const signer = await impersonateAccount(deployerAddress);
    multiProvider.setSigner(fork, signer);
  }

  let config: any;
  let deployer: HyperlaneDeployer<any, any>;
  if (module === Modules.CORE) {
    deployer = new HyperlaneCoreDeployer(multiProvider);
  } else if (module === Modules.INTERCHAIN_GAS_PAYMASTER) {
    deployer = new HyperlaneIgpDeployer(multiProvider);
  } else if (module === Modules.INTERCHAIN_ACCOUNTS) {
    config = await getRouterConfig(environment, multiProvider);
    deployer = new InterchainAccountDeployer(multiProvider);
  } else if (module === Modules.INTERCHAIN_QUERY_SYSTEM) {
    config = await getRouterConfig(environment, multiProvider);
    deployer = new InterchainQueryDeployer(multiProvider);
  } else if (module === Modules.LIQUIDITY_LAYER) {
    deployer = new LiquidityLayerDeployer(multiProvider);
    const routerConfig = await getRouterConfig(environment, multiProvider);
    config = objMap(bridgeAdapterConfigs, (chain, conf) => ({
      ...conf,
      ...routerConfig[chain],
    }));
  } else if (module === Modules.CREATE2_FACTORY) {
    deployer = new Create2FactoryDeployer(multiProvider);
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

  const verification = path.join(modulePath, 'verification.json');

  const cache = {
    addresses,
    verification,
    read: environment !== 'test',
    write: true,
  };
  const agentConfig = ['core', 'igp'].includes(module)
    ? {
        addresses,
        environment,
        multiProvider,
      }
    : undefined;

  await deployWithArtifacts(config, deployer, cache, fork, agentConfig);
}

main()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
