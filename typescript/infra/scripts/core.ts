import {
  buildContracts,
  coreFactories,
  serializeContracts,
} from '@hyperlane-xyz/sdk';

import { deployEnvToSdkEnv } from '../src/config/environment';
import { HyperlaneCoreInfraDeployer } from '../src/core/deploy';
import { readJSON, writeJSON } from '../src/utils/utils';

import {
  getCoreContractsSdkFilepath,
  getCoreEnvironmentConfig,
  getCoreRustDirectory,
  getCoreVerificationDirectory,
  getEnvironment,
} from './utils';

async function main() {
  const environment = await getEnvironment();
  const config = getCoreEnvironmentConfig(environment) as any;
  const multiProvider = await config.getMultiProvider();
  const deployer = new HyperlaneCoreInfraDeployer(
    multiProvider,
    config.core,
    environment,
  );

  let previousContracts = {};
  previousAddressParsing: try {
    if (environment === 'test') {
      break previousAddressParsing;
    }
    const addresses = readJSON(
      getCoreContractsSdkFilepath(),
      `${deployEnvToSdkEnv[environment]}.json`,
    );
    previousContracts = buildContracts(addresses, coreFactories);
  } catch (e) {
    console.info('Could not load partial core addresses, file may not exist');
  }

  try {
    await deployer.deploy(previousContracts);
  } catch (e) {
    console.error(`Encountered error during deploy`);
    console.error(e);
  }

  // Persist artifacts, irrespective of deploy success
  writeJSON(
    getCoreContractsSdkFilepath(),
    `${deployEnvToSdkEnv[environment]}.json`,
    serializeContracts(deployer.deployedContracts),
  );
  const verificationDir = getCoreVerificationDirectory(environment);
  const verificationFile = 'verification.json';
  let existingVerificationInputs = [];
  try {
    existingVerificationInputs = readJSON(verificationDir, verificationFile);
  } finally {
    writeJSON(
      getCoreVerificationDirectory(environment),
      'verification.json',
      deployer.mergeWithExistingVerificationInputs(existingVerificationInputs),
    );
  }
  deployer.writeRustConfigs(getCoreRustDirectory(environment));
}

main().then(console.log).catch(console.error);
