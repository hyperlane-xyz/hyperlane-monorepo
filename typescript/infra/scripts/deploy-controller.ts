import { AbacusCoreDeployer } from '@abacus-network/deploy';
import { AbacusCore, ChainMap, objMap } from '@abacus-network/sdk';

import { ControllerConfig, ControllerDeployer } from '../src/controller';

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
  const controllerConfig: ChainMap<any, ControllerConfig> =
    core.extendWithConnectionManagers(config.controller);

  const deployer = new ControllerDeployer(multiProvider, controllerConfig);
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
