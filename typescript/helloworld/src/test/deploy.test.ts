import '@nomiclabs/hardhat-waffle';
import { ethers } from 'hardhat';

import {
  ChainMap,
  MultiProvider,
  TestChainNames,
  TestCoreApp,
  TestCoreDeployer,
  getMultiProviderFromConfigAndSigner,
} from '@abacus-network/sdk';

import { HelloWorldApp } from '../app/app';
import { HelloWorldContracts } from '../app/contracts';
import { HelloWorldChecker } from '../deploy/check';
import { HelloWorldConfig, getConfigMap, testConfigs } from '../deploy/config';
import { HelloWorldDeployer } from '../deploy/deploy';

describe('deploy', async () => {
  let multiProvider: MultiProvider<TestChainNames>;
  let core: TestCoreApp;
  let config: ChainMap<TestChainNames, HelloWorldConfig>;
  let deployer: HelloWorldDeployer<TestChainNames>;
  let contracts: Record<TestChainNames, HelloWorldContracts>;
  let app: HelloWorldApp<TestChainNames>;

  before(async () => {
    const [signer] = await ethers.getSigners();
    multiProvider = getMultiProviderFromConfigAndSigner(testConfigs, signer);

    const coreDeployer = new TestCoreDeployer(multiProvider);
    const coreContractsMaps = await coreDeployer.deploy();
    core = new TestCoreApp(coreContractsMaps, multiProvider);
    config = core.extendWithConnectionClientConfig(
      getConfigMap(signer.address),
    );
    deployer = new HelloWorldDeployer(multiProvider, config, core);
  });

  it('deploys', async () => {
    contracts = await deployer.deploy();
  });

  it('builds app', async () => {
    contracts = await deployer.deploy();
    app = new HelloWorldApp(contracts, multiProvider);
  });

  it('checks', async () => {
    const checker = new HelloWorldChecker(multiProvider, app, config);
    await checker.check();
    checker.expectEmpty();
  });
});
