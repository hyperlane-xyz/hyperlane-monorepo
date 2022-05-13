import { AbacusCoreDeployer } from '@abacus-network/deploy';
import { AbacusCore, objMap } from '@abacus-network/sdk';

import { AbacusGovernanceDeployer } from '../src/governance';

import {
  getCoreEnvironmentConfig,
  getEnvironment,
  getGovernanceContractsSdkFilepath,
  getGovernanceVerificationDirectory,
} from './utils';

async function main() {
  const environment = await getEnvironment();
  const config = getCoreEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();
  const core = AbacusCore.fromEnvironment(environment, multiProvider);

  const deployer = new AbacusGovernanceDeployer(
    multiProvider,
    config.governance,
    core,
  );
  const addresses = await deployer.deploy();
  deployer.writeContracts(
    addresses,
    getGovernanceContractsSdkFilepath(environment),
  );
  deployer.writeVerification(getGovernanceVerificationDirectory(environment));

  const owners = objMap(addresses, (_, r) => r.router.proxy);
  await AbacusCoreDeployer.transferOwnership(core, owners, multiProvider);
}

main().then(console.log).catch(console.error);
