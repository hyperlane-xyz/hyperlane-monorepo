import { AbacusCore, coreAddresses } from '@abacus-network/sdk';
import {
  getEnvironment,
  getGovernanceConfig,
  getGovernanceContractsSdkFilepath,
  getGovernanceVerificationDirectory,
  registerMultiProvider,
} from './utils';
import { AbacusCoreDeployer } from '../src/core';
import { AbacusGovernanceDeployer } from '../src/governance';

async function main() {
  const environment = await getEnvironment();
  const core = new AbacusCore(coreAddresses[environment]);
  registerMultiProvider(core, environment);

  const config = await getGovernanceConfig(environment, core);
  const deployer = new AbacusGovernanceDeployer();
  await registerMultiProvider(deployer, environment);
  await deployer.deploy(config);
  deployer.writeContracts(getGovernanceContractsSdkFilepath(environment));
  deployer.writeVerification(getGovernanceVerificationDirectory(environment));

  const owners = deployer.routerAddresses;
  await AbacusCoreDeployer.transferOwnership(core, owners);
}

main().then(console.log).catch(console.error);
