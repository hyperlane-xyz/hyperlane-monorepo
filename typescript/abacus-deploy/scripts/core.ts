import {
  getEnvironment,
  getCoreConfig,
  getCoreContractsDirectory,
  getCoreVerificationDirectory,
  getCoreRustDirectory,
  getChainConfigs,
} from './utils';
import { CoreDeploy } from '../src/core';

async function main() {
  const environment = await getEnvironment();
  const chains = await getChainConfigs(environment);
  const config = await getCoreConfig(environment);
  const deploy = new CoreDeploy();
  await deploy.deploy(chains, config);
  deploy.writeContracts(getCoreContractsDirectory(environment));
  deploy.writeVerificationInput(getCoreVerificationDirectory(environment));
  deploy.writeRustConfigs(environment, getCoreRustDirectory(environment));
}

main().then(console.log).catch(console.error);
