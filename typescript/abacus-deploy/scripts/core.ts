import {
  getEnvironment,
  getCoreConfig,
  getCoreContractsDirectory,
  getChainConfigs,
} from './utils';
import { CoreDeploy } from '../src/core/CoreDeploy';

async function main() {
  const environment = await getEnvironment();
  const chains = await getChainConfigs(environment);
  const config = await getCoreConfig(environment);
  const deploy = new CoreDeploy();
  await deploy.deploy(chains, config);
  deploy.writeContracts(getCoreContractsDirectory(environment));
}

main().then(console.log).catch(console.error);
