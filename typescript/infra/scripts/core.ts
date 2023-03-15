import {
  HyperlaneDeployer,
  HyperlaneFactories,
  buildContracts,
  coreFactories,
  serializeContracts,
} from '@hyperlane-xyz/sdk';
import { igpFactories } from '@hyperlane-xyz/sdk/dist/gas/contracts';

import { deployEnvToSdkEnv } from '../src/config/environment';
import { HyperlaneCoreInfraDeployer } from '../src/core/deploy';
import { HyperlaneIgpInfraDeployer } from '../src/gas/deploy';
import { mergeJSON, readJSON, writeJSON } from '../src/utils/utils';

import {
  getArgs,
  getContractAddressesSdkFilepath, // getCoreRustDirectory,
  getEnvironment,
  getEnvironmentConfig,
  getVerificationDirectory,
} from './utils';

// TODO: Switch between core/igp based on flag.
async function main() {
  const { module } = await getArgs()
    .string('module')
    .choices('module', ['core', 'igp'])
    .demandOption('module')
    .alias('m', 'module').argv;
  const environment = await getEnvironment();
  const config = await getEnvironmentConfig();
  const multiProvider = await config.getMultiProvider();

  let factories: HyperlaneFactories;
  let deployer: HyperlaneDeployer<any, any, any>;
  switch (module) {
    case 'core': {
      factories = coreFactories;
      deployer = new HyperlaneCoreInfraDeployer(
        multiProvider,
        config.core,
        environment,
      );
      break;
    }
    case 'igp': {
      factories = igpFactories;
      deployer = new HyperlaneIgpInfraDeployer(
        multiProvider,
        config.igp,
        environment,
      );
      break;
    }
    default:
      throw new Error('Unknown module type');
  }
  let previousContracts = {};
  previousAddressParsing: try {
    if (environment === 'test') {
      console.info('Skipping loading partial addresses for test environment');
      break previousAddressParsing;
    }
    const addresses = readJSON(
      getContractAddressesSdkFilepath(),
      `${deployEnvToSdkEnv[environment]}.json`,
    );
    previousContracts = buildContracts(addresses, factories);
  } catch (e) {
    console.info('Could not load partial addresses, file may not exist');
  }

  try {
    await deployer.deploy(previousContracts);
  } catch (e) {
    console.error(`Encountered error during deploy`);
    console.error(e);
  }

  // Persist artifacts, irrespective of deploy success
  mergeJSON(
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

  //deployer.writeRustConfigs(getCoreRustDirectory());
}

main().then(console.log).catch(console.error);
