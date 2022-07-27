import '@nomiclabs/hardhat-waffle';
import { ethers } from 'hardhat';

import { TestCoreApp } from '../../core/TestCoreApp';
import { TestCoreDeployer } from '../../core/TestCoreDeployer';
import { RouterConfig } from '../../deploy/router/types';
import { EnvironmentConfig } from '../../deploy/types';
import { getChainToOwnerMap, getTestMultiProvider } from '../../deploy/utils';
import { MultiProvider } from '../../providers/MultiProvider';
import { RouterContracts } from '../../router';
import { ChainMap, TestChainNames } from '../../types';

import {
  EnvSubsetApp,
  EnvSubsetChecker,
  EnvSubsetDeployer,
  SubsetChains,
  fullEnvTestConfigs,
  subsetTestConfigs,
} from './app';

// Tests deploying the basic EnvSubsetApp to a local hardhat-based test env
describe('deploy app for full test env', async () => {
  let multiProvider: MultiProvider<TestChainNames>;
  let config: ChainMap<TestChainNames, RouterConfig>;
  let deployer: EnvSubsetDeployer<TestChainNames>;
  let contracts: Record<TestChainNames, RouterContracts>;
  let app: EnvSubsetApp<TestChainNames>;

  before(async () => {
    const testEnv = await initTestEnv(fullEnvTestConfigs);
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
  let multiProvider: MultiProvider<SubsetChains>;
  let config: ChainMap<SubsetChains, RouterConfig>;
  let deployer: EnvSubsetDeployer<SubsetChains>;
  let contracts: Record<SubsetChains, RouterContracts>;
  let app: EnvSubsetApp<SubsetChains>;

  before(async () => {
    const testEnv = await initTestEnv(subsetTestConfigs);
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

async function initTestEnv<Chain extends TestChainNames>(
  environmentConfig: EnvironmentConfig<Chain>,
) {
  const [signer] = await ethers.getSigners();
  const multiProvider = getTestMultiProvider(signer, environmentConfig);

  const coreDeployer = new TestCoreDeployer(multiProvider);
  const coreContractsMaps = await coreDeployer.deploy();
  const core = new TestCoreApp(coreContractsMaps, multiProvider);
  const config = core.extendWithConnectionClientConfig(
    getChainToOwnerMap(fullEnvTestConfigs, signer.address),
  );
  const deployer = new EnvSubsetDeployer(multiProvider, config, core);
  return { multiProvider, config, deployer };
}
