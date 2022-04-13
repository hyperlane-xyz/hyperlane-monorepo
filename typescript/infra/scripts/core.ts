import { utils } from '@abacus-network/deploy';
import {
  getEnvironment,
  getCoreEnvironmentConfig,
  getCoreContractsSdkFilepath,
  getCoreRustDirectory,
  getCoreVerificationDirectory,
} from './utils';
import { AbacusCoreDeployer } from '../src/core';

async function main() {
  const environment = await getEnvironment();
  const deployer = new AbacusCoreDeployer();
  const config = await getCoreEnvironmentConfig(environment);
  await utils.registerEnvironment(deployer, config);
  await deployer.deploy(config.core);

  deployer.writeContracts(getCoreContractsSdkFilepath(environment));
  deployer.writeVerification(getCoreVerificationDirectory(environment));
  deployer.writeRustConfigs(environment, getCoreRustDirectory(environment));
}

main().then(console.log).catch(console.error);
