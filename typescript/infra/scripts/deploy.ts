import {
  ChainMap,
  HyperlaneDeployer,
  HyperlaneFactories,
  InterchainAccountDeployer,
  InterchainQueryDeployer,
  buildContracts,
  coreFactories,
  interchainAccountFactories,
  interchainQueryFactories,
  serializeContracts,
} from '@hyperlane-xyz/sdk';
import { igpFactories } from '@hyperlane-xyz/sdk/dist/gas/contracts';

import { deployEnvToSdkEnv } from '../src/config/environment';
import { HyperlaneCoreInfraDeployer } from '../src/core/deploy';
import { factories as create2Factories } from '../src/create2';
import { Create2FactoryDeployer } from '../src/create2';
import { HyperlaneIgpInfraDeployer } from '../src/gas/deploy';
import { impersonateAccount, useLocalProvider } from '../src/utils/fork';
import { readJSON, writeJSON, writeMergedJSON } from '../src/utils/utils';

import {
  getArgsWithModuleAndFork,
  getContractAddressesSdkFilepath,
  getEnvironmentConfig,
  getRouterConfig,
  getVerificationDirectory,
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

  let factories: HyperlaneFactories;
  let deployer: HyperlaneDeployer<any, any, any>;
  let configMap: ChainMap<any>;
  if (module === 'core') {
    factories = coreFactories;
    configMap = config.core;
    deployer = new HyperlaneCoreInfraDeployer(
      multiProvider,
      configMap,
      environment,
    );
  } else if (module === 'igp') {
    factories = igpFactories;
    configMap = config.igp;
    deployer = new HyperlaneIgpInfraDeployer(
      multiProvider,
      config.igp,
      environment,
    );
  } else if (module === 'ica') {
    factories = interchainAccountFactories;
    configMap = await getRouterConfig(environment, multiProvider);
    deployer = new InterchainAccountDeployer(multiProvider, configMap);
  } else if (module === 'iqs') {
    factories = interchainQueryFactories;
    configMap = await getRouterConfig(environment, multiProvider);
    deployer = new InterchainQueryDeployer(multiProvider, configMap);
  } else if (module === 'create2') {
    factories = create2Factories;
    deployer = new Create2FactoryDeployer(multiProvider);
    configMap = {};
  } else {
    throw new Error('Unknown module type');
  }

  if (environment !== 'test') {
    try {
      const addresses = readJSON(
        getContractAddressesSdkFilepath(),
        `${deployEnvToSdkEnv[environment]}.json`,
      );
      deployer.cacheContracts(buildContracts(addresses, factories) as any);
    } catch (e) {
      console.info('Could not load partial addresses, file may not exist');
    }
  }

  if (fork) {
    await deployer.deployContracts(fork, configMap[fork]);
    return;
  }

  try {
    await deployer.deploy();
  } catch (e) {
    console.error('Encountered error during deploy', e);
  }

  // Persist address artifacts, irrespective of deploy success
  writeMergedJSON(
    getContractAddressesSdkFilepath(),
    `${deployEnvToSdkEnv[environment]}.json`,
    serializeContracts(deployer.deployedContracts),
  );
  const verificationDir = getVerificationDirectory(environment, module);
  const verificationFile = 'verification.json';
  let existingVerificationInputs = [];
  try {
    existingVerificationInputs = readJSON(verificationDir, verificationFile);
  } catch (err) {
    /* ignore error */
  }

  writeJSON(
    verificationDir,
    verificationFile,
    deployer.mergeWithExistingVerificationInputs(existingVerificationInputs),
  );
}

main()
  .then()
  .catch(() => process.exit(1));
