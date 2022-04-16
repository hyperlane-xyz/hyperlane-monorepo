import { utils } from '@abacus-network/deploy';
import { AbacusCore, coreAddresses } from '@abacus-network/sdk';
import { AbacusCoreDeployer } from '../src/core';
import { AbacusGovernanceDeployer } from '../src/governance';
import {
  getCoreEnvironmentConfig,
  getEnvironment,
  getGovernanceContractsSdkFilepath,
  getGovernanceVerificationDirectory,
} from './utils';

async function main() {
  const environment = await getEnvironment();
  const core = new AbacusCore(coreAddresses);
  const config = await getCoreEnvironmentConfig(environment);
  utils.registerEnvironment(core, config);

  const deployer = new AbacusGovernanceDeployer();
  utils.registerEnvironment(core, config);
  await deployer.deploy(config.governance);
  deployer.writeContracts(getGovernanceContractsSdkFilepath(environment));
  deployer.writeVerification(getGovernanceVerificationDirectory(environment));

  const owners = deployer.routerAddresses;
  await AbacusCoreDeployer.transferOwnership(core, owners);
}

main().then(console.log).catch(console.error);
