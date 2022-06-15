import { utils } from '@abacus-network/deploy';
// TODO export TestCoreApp from @abacus-network/hardhat properly
import { TestCoreApp } from '@abacus-network/hardhat/dist/src/TestCoreApp';
// TODO export TestCoreDeploy from @abacus-network/hardhat properly
import { TestCoreDeploy } from '@abacus-network/hardhat/dist/src/TestCoreDeploy';
import { ChainMap, MultiProvider, TestChainNames } from '@abacus-network/sdk';
import '@nomiclabs/hardhat-waffle';
import { ethers } from 'hardhat';
import { HelloWorldChecker } from '../deploy/check';
import { getConfigMap, HelloWorldConfig, testConfigs } from '../deploy/config';
import { HelloWorldDeployer } from '../deploy/deploy';
import { HelloWorldApp } from '../sdk/app';
import { HelloWorldContracts } from '../sdk/contracts';

describe('deploy', async () => {
  let multiProvider: MultiProvider<TestChainNames>;
  let core: TestCoreApp;
  let config: ChainMap<TestChainNames, HelloWorldConfig>;
  let deployer: HelloWorldDeployer<TestChainNames>;
  let contracts: Record<TestChainNames, HelloWorldContracts>;
  let app: HelloWorldApp<TestChainNames>;

  before(async () => {
    const [signer] = await ethers.getSigners();
    multiProvider = utils.getMultiProviderFromConfigAndSigner(
      testConfigs,
      signer,
    );

    const coreDeployer = new TestCoreDeploy(multiProvider);
    const coreContractsMaps = await coreDeployer.deploy();
    core = new TestCoreApp(coreContractsMaps, multiProvider);
    config = core.extendWithConnectionManagers(getConfigMap(signer.address));
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
