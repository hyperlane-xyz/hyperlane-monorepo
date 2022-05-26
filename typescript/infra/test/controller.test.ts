import '@nomiclabs/hardhat-waffle';
import { ethers } from 'hardhat';
import path from 'path';

import { RouterConfig } from '@abacus-network/deploy';
import { getMultiProviderFromConfigAndSigner } from '@abacus-network/deploy/dist/src/utils';
import {
  AbacusCore,
  ChainMap,
  ControllerAddresses,
  ControllerApp,
  MultiProvider,
} from '@abacus-network/sdk';

import { environment as config } from '../config/environments/test';
import { TestChains } from '../config/environments/test/chains';
import {
  ControllerChecker,
  ControllerConfig,
  ControllerDeployer,
} from '../src/controller';

describe('controller', async () => {
  let multiProvider: MultiProvider<TestChains>;
  let deployer: ControllerDeployer<TestChains>;
  let addresses: ChainMap<TestChains, ControllerAddresses>;
  let controllerConfig: ChainMap<TestChains, ControllerConfig & RouterConfig>;

  before(async () => {
    const [signer] = await ethers.getSigners();
    // This is kind of awkward and really these tests shouldn't live here
    multiProvider = getMultiProviderFromConfigAndSigner(
      config.transactionConfigs,
      signer,
    );
    const core: AbacusCore<TestChains> = AbacusCore.fromEnvironment(
      'test',
      multiProvider,
    );

    deployer = new ControllerDeployer(
      multiProvider,
      core.extendWithConnectionManagers(config.controller),
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
      controllerConfig,
    );
    await checker.check();
  });
});
