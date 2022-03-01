import { getCoreDeploys, getEnvironment } from './utils';
import { ImplementationDeployer } from '../src/core/implementation';

async function main() {
  const environment = await getEnvironment();
  const coreDeploys = await getCoreDeploys(environment);
  const deployer = new ImplementationDeployer(coreDeploys);
  await deployer.deployInboxImplementations();
  deployer.writeDeploys(environment);
}
main().then(console.log).catch(console.error);
