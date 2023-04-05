import path from 'path';

import {
  HyperlaneDeployer,
  HyperlaneIgp,
  InterchainAccountDeployer,
  InterchainQueryDeployer,
  LiquidityLayerDeployer,
  objMap,
} from '@hyperlane-xyz/sdk';

import { bridgeAdapterConfigs } from '../config/environments/test/liquidityLayer';
import { deployEnvToSdkEnv } from '../src/config/environment';
import { HyperlaneCoreInfraDeployer } from '../src/core/deploy';
import { Create2FactoryDeployer } from '../src/create2';
import { deployWithArtifacts } from '../src/deploy';
import { HyperlaneIgpInfraDeployer } from '../src/gas/deploy';
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
  const config = await getEnvironmentConfig();
  const multiProvider = await config.getMultiProvider();

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

  let deployer: HyperlaneDeployer<any, any>;
  if (module === Modules.CORE) {
    deployer = new HyperlaneCoreInfraDeployer(
      multiProvider,
      config.core,
      environment,
    );
  } else if (module === Modules.INTERCHAIN_GAS_PAYMASTER) {
    deployer = new HyperlaneIgpInfraDeployer(
      multiProvider,
      config.igp,
      environment,
    );
  } else if (module === Modules.INTERCHAIN_ACCOUNTS) {
    const config = await getRouterConfig(environment, multiProvider);
    deployer = new InterchainAccountDeployer(multiProvider, config);
  } else if (module === Modules.INTERCHAIN_QUERY_SYSTEM) {
    const config = await getRouterConfig(environment, multiProvider);
    deployer = new InterchainQueryDeployer(multiProvider, config);
  } else if (module === Modules.LIQUIDITY_LAYER) {
    const routerConfig = await getRouterConfig(environment, multiProvider);
    const config = objMap(bridgeAdapterConfigs, (chain, conf) => ({
      ...conf,
      ...routerConfig[chain],
    }));
    deployer = new LiquidityLayerDeployer(multiProvider, config);
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
    const queryRouterAddresses = objMap(
      readJSON(queryRouterDir, 'addresses.json'),
      (_c, conf) => ({ queryRouterAddress: conf.router }),
    );
    deployer = new TestQuerySenderDeployer(
      multiProvider,
      queryRouterAddresses,
      igp,
    );
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
  // Don't write agent config in fork tests
  const agentConfig =
    ['core', 'igp'].includes(module) && !fork
      ? {
          addresses,
          environment,
          multiProvider,
        }
      : undefined;

  await deployWithArtifacts(deployer, cache, fork, agentConfig);
}

main()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
