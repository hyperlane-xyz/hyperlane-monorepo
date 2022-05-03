import { AbacusCore, utils as sdkUtils } from '@abacus-network/sdk';

import { AbacusCoreDeployer } from '../src/core';
import { AbacusGovernanceDeployer } from '../src/governance';

import {
  getCoreEnvironmentConfig,
  getEnvironment,
  getGovernanceContractsSdkFilepath,
  getGovernanceVerificationDirectory,
  getMultiProvider,
} from './utils';

async function main() {
  const environment = await getEnvironment();
  const config = await getCoreEnvironmentConfig(environment);
  const multiProvider = await getMultiProvider(environment);
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

  const owners = sdkUtils.objMap(addresses, (_, r) => r.router.proxy);
  await AbacusCoreDeployer.transferOwnership(core, owners, multiProvider);
}

main().then(console.log).catch(console.error);
