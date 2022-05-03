import { AbacusCoreDeployer } from '../src/core';

import {
  getCoreConfig,
  getCoreContractsSdkFilepath,
  getCoreRustDirectory,
  getCoreVerificationDirectory,
  getEnvironment,
  registerMultiProvider,
} from './utils';

async function main() {
  const environment = await getEnvironment();
  const deployer = new AbacusCoreDeployer();
  await registerMultiProvider(deployer, environment);

  const config = await getCoreConfig(environment);
  await deployer.deploy(config);

  deployer.writeContracts(getCoreContractsSdkFilepath(environment));
  deployer.writeVerification(getCoreVerificationDirectory(environment));
  deployer.writeRustConfigs(environment, getCoreRustDirectory(environment));
}

main().then(console.log).catch(console.error);
