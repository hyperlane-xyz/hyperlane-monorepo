import { AbacusCoreInfraDeployer } from '../src/core/deploy';

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
  const deployer = new AbacusCoreInfraDeployer(multiProvider, config.core);

  const contracts = await deployer.deploy();

  deployer.writeContracts(contracts, getCoreContractsSdkFilepath(environment));
  deployer.writeVerification(getCoreVerificationDirectory(environment));
  deployer.writeRustConfigs(
    environment,
    getCoreRustDirectory(environment),
    contracts,
  );
}

main().then(console.log).catch(console.error);
