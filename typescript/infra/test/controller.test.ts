import '@nomiclabs/hardhat-waffle';
import path from 'path';

import {
  AbacusCore,
  ControllerApp,
  ChainMap,
  ControllerAddresses,
  MultiProvider,
} from '@abacus-network/sdk';

import { TestNetworks } from '../config/environments/test/domains';
import { getCoreEnvironmentConfig } from '../scripts/utils';
import {
  ControllerChecker,
  ControllerDeployer,
  ControllerConfig,
} from '../src/controller';

describe('controller', async () => {
  const environment = 'test';

  let multiProvider: MultiProvider<TestNetworks>;
  let deployer: ControllerDeployer<TestNetworks>;
  let addresses: ChainMap<TestNetworks, ControllerAddresses>;
  let controllerConfig: ChainMap<TestNetworks, ControllerConfig>;

  before(async () => {
    const config = getCoreEnvironmentConfig(environment);
    controllerConfig = config.controller;
    multiProvider = await config.getMultiProvider();

    const core = AbacusCore.fromEnvironment(environment, multiProvider);
    console.log(core);
    deployer = new ControllerDeployer(
      multiProvider,
      controllerConfig,
      core,
    );
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
      controllerConfig
    );
    await checker.check();
  });
});
