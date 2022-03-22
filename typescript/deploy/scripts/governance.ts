import { core, bridge } from '@abacus-network/sdk';
import {
  getEnvironment,
  getGovernanceConfig,
  getGovernanceDirectory,
  registerMultiProvider,
} from './utils';
import { AbacusGovernanceDeployer } from '../src/governance';

async function main() {
  const environment = await getEnvironment();
  const config = await getGovernanceConfig(environment);
  const deployer = new AbacusGovernanceDeployer();
  await registerMultiProvider(deployer, environment);
  await deployer.deploy(config);
  deployer.writeOutput(getGovernanceDirectory(environment));

  const abacusCore = core[environment];
  const abacusBridge = bridge[environment];
  registerMultiProvider(abacusCore, environment);
  registerMultiProvider(abacusBridge, environment);

  await abacusCore.transferOwnership(deployer.routerAddresses());
  await abacusBridge.transferOwnership(deployer.routerAddresses());
}

main().then(console.log).catch(console.error);
