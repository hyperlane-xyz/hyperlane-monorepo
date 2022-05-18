import { AbacusCoreDeployer } from '@abacus-network/deploy';
import { AbacusCore, objMap } from '@abacus-network/sdk';

import { ControllerDeployer } from '../src/controller';

import {
  getControllerContractsSdkFilepath,
  getControllerVerificationDirectory,
  getCoreEnvironmentConfig,
  getEnvironment,
} from './utils';

async function main() {
  const environment = await getEnvironment();
  const config = getCoreEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();
  const core = AbacusCore.fromEnvironment(environment, multiProvider);

  const deployer = new ControllerDeployer(
    multiProvider,
    config.controller,
    core,
  );
  const addresses = await deployer.deploy();
  deployer.writeContracts(
    addresses,
    getControllerContractsSdkFilepath(environment),
  );
  deployer.writeVerification(getControllerVerificationDirectory(environment));

  const owners = objMap(addresses, (_, r) => r.router.proxy);
  await AbacusCoreDeployer.transferOwnership(core, owners, multiProvider);
}

main().then(console.log).catch(console.error);
