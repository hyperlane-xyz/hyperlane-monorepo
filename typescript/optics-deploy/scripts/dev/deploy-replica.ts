import { makeCoreDeploys } from '../../src/core/CoreDeploy';
import { ImplementationDeployer } from '../../src/core/implementation';
import { core } from '../../config/environments/dev/core';
import { chains } from '../../config/environments/dev/chains';

const environment = 'dev';
const coreDeploys = makeCoreDeploys(environment, chains, core);

async function main() {
  const deployer = new ImplementationDeployer(coreDeploys);
  await deployer.deployReplicaImplementations();
  deployer.writeDeploys(environment);
}
main().then(console.log).catch(console.error);
