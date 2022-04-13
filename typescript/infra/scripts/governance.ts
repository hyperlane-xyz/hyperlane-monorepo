import { utils } from '@abacus-network/deploy';
import { AbacusCore } from '@abacus-network/sdk';
import {
  getEnvironment,
  getCoreEnvironmentConfig,
  getGovernanceContractsSdkFilepath,
  getGovernanceVerificationDirectory,
} from './utils';
import { AbacusCoreDeployer } from '../src/core';
import { AbacusGovernanceDeployer } from '../src/governance';

async function main() {
  const environment = await getEnvironment();
  const core = new AbacusCore(environment);
  const config = await getCoreEnvironmentConfig(environment);
  await utils.registerEnvironment(core, config);

  const deployer = new AbacusGovernanceDeployer();
  await utils.registerEnvironment(core, config);
  await deployer.deploy(config.governance);
  deployer.writeContracts(getGovernanceContractsSdkFilepath(environment));
  deployer.writeVerification(getGovernanceVerificationDirectory(environment));

  const owners = deployer.routerAddresses;
  await AbacusCoreDeployer.transferOwnership(core, owners);
}

main().then(console.log).catch(console.error);
