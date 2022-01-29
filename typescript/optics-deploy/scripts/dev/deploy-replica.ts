import { ImplementationDeployer } from '../../src/core/implementation';
import { configPath, networks } from './agentConfig';
import { makeCoreDeploys } from '../../src/core/CoreDeploy';

const coreDeploys = makeCoreDeploys(
  configPath,
  networks,
  (_) => _.chain,
  (_) => _.devConfig,
);

async function main() {
  const deployer = new ImplementationDeployer(coreDeploys);
  await deployer.deployReplicaImplementations();
  deployer.writeDeploys(configPath)
}
main().then(console.log).catch(console.error);

