import { AbacusCoreDeployer } from '../src/core';

import {
  getCoreContractsSdkFilepath,
  getCoreEnvironmentConfig,
  getCoreRustDirectory,
  getCoreVerificationDirectory,
  getEnvironment,
} from './utils';

async function main() {
  const environment = await getEnvironment();
  const config = await getCoreEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();
  const deployer = new AbacusCoreDeployer(
    multiProvider,
    config.core.validatorManagers,
  );
  return;
  const addresses = await deployer.deploy();

  deployer.writeContracts(addresses, getCoreContractsSdkFilepath(environment));
  deployer.writeVerification(getCoreVerificationDirectory(environment));
  deployer.writeRustConfigs(
    environment,
    getCoreRustDirectory(environment),
    addresses,
  );
}

main().then(console.log).catch(console.error);
