import '@nomiclabs/hardhat-waffle';
import { ethers } from 'hardhat';

import { TestChains } from '../../consts/chains';
import { TestCoreApp } from '../../core/TestCoreApp';
import { TestCoreDeployer } from '../../core/TestCoreDeployer';
import { MultiProvider } from '../../providers/MultiProvider';
import { RouterConfig } from '../../router/types';
import { ChainMap, ChainName } from '../../types';
import { deployTestIgpsAndGetRouterConfig, testCoreConfig } from '../testUtils';

import {
  EnvSubsetApp,
  EnvSubsetChecker,
  EnvSubsetDeployer,
  TestRouterContracts,
} from './app';

// Tests deploying the basic EnvSubsetApp to a local hardhat-based test env
describe('deploy app for full test env', async () => {
  let multiProvider: MultiProvider;
  let config: ChainMap<RouterConfig>;
  let deployer: EnvSubsetDeployer;
  let contracts: ChainMap<TestRouterContracts>;
  let app: EnvSubsetApp;

  before(async () => {
    const testEnv = await initTestEnv(TestChains);
    multiProvider = testEnv.multiProvider;
    config = testEnv.config;
    deployer = testEnv.deployer;
  });

  it('deploys', async () => {
    contracts = await deployer.deploy();
  });

  it('builds app', async () => {
    app = new EnvSubsetApp(contracts, multiProvider);
  });

  it('checks', async () => {
    const checker = new EnvSubsetChecker(multiProvider, app, config);
    await checker.check();
    checker.expectEmpty();
  });
});

// Tests same as above but only a subset of the full test env
describe('deploy app to test env subset', async () => {
  let multiProvider: MultiProvider;
  let config: ChainMap<RouterConfig>;
  let deployer: EnvSubsetDeployer;
  let contracts: ChainMap<TestRouterContracts>;
  let app: EnvSubsetApp;

  before(async () => {
    ({ multiProvider, config, deployer } = await initTestEnv([
      'test1',
      'test2',
    ]));
  });

  it('deploys', async () => {
    contracts = await deployer.deploy();
  });

  it('builds app', async () => {
    app = new EnvSubsetApp(contracts, multiProvider);
  });

  it('checks', async () => {
    const checker = new EnvSubsetChecker(multiProvider, app, config);
    await checker.check();
    checker.expectEmpty();
  });
});

async function initTestEnv(chains: ChainName[]) {
  const [signer] = await ethers.getSigners();
  const multiProvider = MultiProvider.createTestMultiProvider(
    { signer },
    chains,
  );
  const coreConfig = testCoreConfig(chains);
  const coreDeployer = new TestCoreDeployer(multiProvider, coreConfig);
  const coreContractsMaps = await coreDeployer.deploy();
  const core = new TestCoreApp(coreContractsMaps, multiProvider);
  const config = await deployTestIgpsAndGetRouterConfig(
    multiProvider,
    signer.address,
    coreContractsMaps,
  );
  const deployer = new EnvSubsetDeployer(multiProvider, config, core);
  return { multiProvider, config, deployer };
}
