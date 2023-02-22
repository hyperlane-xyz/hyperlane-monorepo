import '@nomiclabs/hardhat-waffle';
import { ethers } from 'hardhat';

import { ChainMetadata } from '../../consts/chainMetadata';
import { TestCoreApp } from '../../core/TestCoreApp';
import { TestCoreDeployer } from '../../core/TestCoreDeployer';
import { RouterConfig } from '../../deploy/router/types';
import { getChainToOwnerMap } from '../../deploy/utils';
import { MultiProvider } from '../../providers/MultiProvider';
import { RouterContracts } from '../../router';
import { ChainMap } from '../../types';

import {
  EnvSubsetApp,
  EnvSubsetChecker,
  EnvSubsetDeployer,
  fullTestEnvConfigs,
  subsetTestConfigs,
} from './app';

// Tests deploying the basic EnvSubsetApp to a local hardhat-based test env
describe('deploy app for full test env', async () => {
  let multiProvider: MultiProvider;
  let config: ChainMap<RouterConfig>;
  let deployer: EnvSubsetDeployer;
  let contracts: ChainMap<RouterContracts>;
  let app: EnvSubsetApp;

  before(async () => {
    const testEnv = await initTestEnv(fullTestEnvConfigs);
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
  let contracts: ChainMap<RouterContracts>;
  let app: EnvSubsetApp;

  before(async () => {
    const testEnv = await initTestEnv(subsetTestConfigs);
    multiProvider = testEnv.multiProvider;
    config = {
      test1: testEnv.config.test1,
      test2: testEnv.config.test2,
    };
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

async function initTestEnv(environmentConfig: ChainMap<ChainMetadata>) {
  const [signer] = await ethers.getSigners();
  const multiProvider = MultiProvider.createTestMultiProvider({ signer });

  const coreDeployer = new TestCoreDeployer(multiProvider);
  const coreContractsMaps = await coreDeployer.deploy();
  const core = new TestCoreApp(coreContractsMaps, multiProvider);
  const config = core.extendWithConnectionClientConfig(
    getChainToOwnerMap(environmentConfig, signer.address),
  );
  const deployer = new EnvSubsetDeployer(multiProvider, config, core);
  return { multiProvider, config, deployer };
}
