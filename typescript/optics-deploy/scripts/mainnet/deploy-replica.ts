import { makeCoreDeploys } from '../../src/core/CoreDeploy';
import { ImplementationDeployer } from '../../src/core/implementation';
import { core } from '../../config/environments/mainnet/core';
import { chains } from '../../config/environments/mainnet/chains';

const environment = 'mainnet';
const coreDeploys = makeCoreDeploys(environment, chains, core);

async function main() {
  const deployer = new ImplementationDeployer(coreDeploys);
  await deployer.deployReplicaImplementations();
  deployer.writeDeploys(environment);
}
main().then(console.log).catch(console.error);
