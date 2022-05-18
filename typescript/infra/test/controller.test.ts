import '@nomiclabs/hardhat-waffle';
import path from 'path';

import {
  AbacusCore,
  ChainMap,
  ControllerAddresses,
  ControllerApp,
  MultiProvider,
} from '@abacus-network/sdk';

import { TestChains } from '../config/environments/test/chains';
import { getCoreEnvironmentConfig } from '../scripts/utils';
import {
  ControllerChecker,
  ControllerConfig,
  ControllerDeployer,
} from '../src/controller';

describe('controller', async () => {
  const environment = 'test';

  let multiProvider: MultiProvider<TestChains>;
  let deployer: ControllerDeployer<TestChains>;
  let addresses: ChainMap<TestChains, ControllerAddresses>;
  let controllerConfig: ChainMap<TestChains, ControllerConfig>;

  before(async () => {
    const config = getCoreEnvironmentConfig(environment);
    controllerConfig = config.controller;
    multiProvider = await config.getMultiProvider();

    const core = AbacusCore.fromEnvironment(environment, multiProvider);
    console.log(core);
    deployer = new ControllerDeployer(multiProvider, controllerConfig, core);
  });

  it('deploys', async () => {
    addresses = await deployer.deploy();
  });

  it('writes', async () => {
    const base = './test/outputs/controller';
    deployer.writeVerification(path.join(base, 'verification'));
    deployer.writeContracts(addresses, path.join(base, 'contracts.ts'));
  });

  it('checks', async () => {
    const controller = new ControllerApp(addresses, multiProvider);
    const checker = new ControllerChecker(
      multiProvider,
      controller,
      controllerConfig,
    );
    await checker.check();
  });
});
