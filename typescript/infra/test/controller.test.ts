import {
  AbacusCore,
  ChainMap,
  ControllerAddresses,
  ControllerApp,
  MultiProvider
} from '@abacus-network/sdk';
import '@nomiclabs/hardhat-waffle';
import { TestNetworks } from '../config/environments/test/domains';
import { getCoreEnvironmentConfig } from '../scripts/utils';
import {
  ControllerChecker,
  ControllerConfig,
  ControllerDeployer
} from '../src/controller';
import { writeContracts, writeVerification } from '../src/utils/utils';

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
    deployer = new ControllerDeployer(multiProvider, controllerConfig, core);
  });

  it('deploys', async () => {
    addresses = await deployer.deploy();
  });

  it('writes', async () => {
    const base = './test/outputs/controller';
    writeVerification(deployer.verificationInputs, base);
    writeContracts(addresses, base);
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
