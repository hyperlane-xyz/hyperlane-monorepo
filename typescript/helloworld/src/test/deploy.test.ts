import '@nomiclabs/hardhat-waffle';
import hre from 'hardhat';

import {
  ChainMap,
  HyperlaneContractsMap,
  HyperlaneIsmFactory,
  HyperlaneProxyFactoryDeployer,
  MultiProvider,
  TestCoreApp,
  TestCoreDeployer,
} from '@hyperlane-xyz/sdk';

import { HelloWorldApp } from '../app/app.js';
import { HelloWorldFactories } from '../app/contracts.js';
import { HelloWorldChecker } from '../deploy/check.js';
import { HelloWorldConfig } from '../deploy/config.js';
import { HelloWorldDeployer } from '../deploy/deploy.js';

describe('deploy', () => {
  let multiProvider: MultiProvider;
  let core: TestCoreApp;
  let config: ChainMap<HelloWorldConfig>;
  let deployer: HelloWorldDeployer;
  let contracts: HyperlaneContractsMap<HelloWorldFactories>;
  let app: HelloWorldApp;

  before(async () => {
    const [signer] = await hre.ethers.getSigners();
    multiProvider = MultiProvider.createTestMultiProvider({ signer });
    const ismFactoryDeployer = new HyperlaneProxyFactoryDeployer(multiProvider);
    const ismFactory = new HyperlaneIsmFactory(
      await ismFactoryDeployer.deploy(multiProvider.mapKnownChains(() => ({}))),
      multiProvider,
    );
    const coreDeployer = new TestCoreDeployer(multiProvider, ismFactory);
    core = await coreDeployer.deployApp();
    config = core.getRouterConfig(signer.address);
    deployer = new HelloWorldDeployer(multiProvider);
  });

  // eslint-disable-next-line jest/expect-expect -- testing deploy doesn't throw
  it('deploys', async () => {
    contracts = await deployer.deploy(config);
  });

  // eslint-disable-next-line jest/expect-expect -- testing app construction doesn't throw
  it('builds app', async () => {
    contracts = await deployer.deploy(config);
    app = new HelloWorldApp(core, contracts, multiProvider);
  });

  it('checks', async () => {
    const checker = new HelloWorldChecker(multiProvider, app, config);
    await checker.check();
    checker.expectEmpty();
  });
});
