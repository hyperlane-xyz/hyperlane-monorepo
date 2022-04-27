import { utils } from '@abacus-network/deploy';
import { AbacusCore } from '@abacus-network/sdk';
import { objMap } from '@abacus-network/sdk/dist/utils';
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
  if (environment !== 'test') {
    throw new Error(`Do not have addresses for ${environment} in SDK`);
  }

  const config = await getCoreEnvironmentConfig(environment);

  const multiProvider = utils.initHardhatMultiProvider(config);
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
