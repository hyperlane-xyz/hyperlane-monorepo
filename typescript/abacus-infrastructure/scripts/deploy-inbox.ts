import {
  getCoreDeploy,
  getCoreContractsDirectory,
  getCoreConfig,
  getEnvironment,
} from './utils';
import { ImplementationDeployer } from '../src/core/implementation';

async function main() {
  const environment = await getEnvironment();
  const coreDeploy = await getCoreDeploy(environment);
  const coreConfig = await getCoreConfig(environment);
  const deployer = new ImplementationDeployer(coreDeploy, coreConfig);
  await deployer.deployInboxImplementations();
  coreDeploy.writeContracts(getCoreContractsDirectory(environment));
}
main().then(console.log).catch(console.error);
