import '@nomiclabs/hardhat-waffle';
import { ethers } from 'hardhat';

import { TestCoreApp } from '../../core/TestCoreApp';
import { TestCoreDeployer } from '../../core/TestCoreDeployer';
import { RouterConfig } from '../../deploy/router/types';
import {
  getChainToOwnerMap,
  getMultiProviderFromConfigAndSigner,
} from '../../deploy/utils';
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

describe('deploy app for full env', async () => {
  let multiProvider: MultiProvider<TestChainNames>;
  let config: ChainMap<TestChainNames, RouterConfig>;
  let deployer: EnvSubsetDeployer<TestChainNames>;
  let contracts: Record<TestChainNames, RouterContracts>;
  let app: EnvSubsetApp<TestChainNames>;

  before(async () => {
    const [signer] = await ethers.getSigners();
    multiProvider = getMultiProviderFromConfigAndSigner(
      fullEnvTestConfigs,
      signer,
    );

    const coreDeployer = new TestCoreDeployer(multiProvider);
    const coreContractsMaps = await coreDeployer.deploy();
    const core = new TestCoreApp(coreContractsMaps, multiProvider);
    config = core.extendWithConnectionClientConfig(
      getChainToOwnerMap(fullEnvTestConfigs, signer.address),
    );
    deployer = new EnvSubsetDeployer(multiProvider, config, core);
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

// TODO DRY with above before()
// TODO only
describe.only('deploy app to env subset', async () => {
  let multiProvider: MultiProvider<SubsetChains>;
  let config: ChainMap<SubsetChains, RouterConfig>;
  let deployer: EnvSubsetDeployer<SubsetChains>;
  let contracts: Record<SubsetChains, RouterContracts>;
  let app: EnvSubsetApp<SubsetChains>;

  before(async () => {
    const [signer] = await ethers.getSigners();
    multiProvider = getMultiProviderFromConfigAndSigner(
      subsetTestConfigs,
      signer,
    );

    const coreDeployer = new TestCoreDeployer(multiProvider);
    const coreContractsMaps = await coreDeployer.deploy();
    const core = new TestCoreApp(coreContractsMaps, multiProvider);
    config = core.extendWithConnectionClientConfig(
      getChainToOwnerMap(subsetTestConfigs, signer.address),
    );
    deployer = new EnvSubsetDeployer(multiProvider, config, core);
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
