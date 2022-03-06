import {
  getEnvironment,
  getCoreConfig,
  getCoreDirectory,
  getChainConfigsRecord,
} from './utils';
import { CoreDeploy } from '../src/core';

async function main() {
  const environment = await getEnvironment();
  const chains = await getChainConfigsRecord(environment);
  const config = await getCoreConfig(environment);
  const deploy = new CoreDeploy();
  await deploy.deploy(chains, config);
  const outputDir = getCoreDirectory(environment);
  deploy.writeContracts(outputDir);
  deploy.writeVerificationInput(outputDir);
  deploy.writeRustConfigs(environment, outputDir);
}

main().then(console.log).catch(console.error);
