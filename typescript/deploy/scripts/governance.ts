import {
  getEnvironment,
  getGovernanceConfig,
  getGovernanceDirectory,
} from './utils';
import { AbacusGovernanceDeployer } from '../src/governance';

async function main() {
  const environment = await getEnvironment();
  const config = await getGovernanceConfig(environment);
  const deployer = new AbacusGovernanceDeployer();
  // TODO(asa): Register multiprovider...
  await registerDeployer(deployer, environment);
  await deployer.deploy(config);
  deployer.writeOutput(getGovernanceDirectory(environment));

  /*
  const core = getAbacusCore(environment);
  await core.transferOwnership(deploy.routerAddresses());

  const bridge = await getBridgeDeploy(environment);
  await bridge.transferOwnership(deploy.routerAddresses());
  */
}

main().then(console.log).catch(console.error);
