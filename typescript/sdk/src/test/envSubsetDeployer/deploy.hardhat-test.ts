import '@nomiclabs/hardhat-waffle';
import { ethers } from 'hardhat';

import { TestCoreApp } from '../../core/TestCoreApp';
import { TestCoreDeployer } from '../../core/TestCoreDeployer';
import { RouterConfig } from '../../deploy/router/types';
import { getMultiProviderFromConfigAndSigner } from '../../deploy/utils';
import { MultiProvider } from '../../providers/MultiProvider';
import { RouterContracts } from '../../router';
import { ChainMap, TestChainNames } from '../../types';

import {
  EnvSubsetApp,
  EnvSubsetChecker,
  EnvSubsetDeployer,
  testConfigs,
} from './app';

describe('deploy env to app', async () => {
  let multiProvider: MultiProvider<TestChainNames>;
  let core: TestCoreApp;
  let config: ChainMap<TestChainNames, RouterConfig>;
  let deployer: EnvSubsetDeployer<TestChainNames>;
  let contracts: Record<TestChainNames, RouterContracts>;
  let app: EnvSubsetApp<TestChainNames>;

  before(async () => {
    const [signer] = await ethers.getSigners();
    multiProvider = getMultiProviderFromConfigAndSigner(testConfigs, signer);

    const coreDeployer = new TestCoreDeployer(multiProvider);
    const coreContractsMaps = await coreDeployer.deploy();
    core = new TestCoreApp(coreContractsMaps, multiProvider);
    config = core.extendWithConnectionClientConfig({
      test1: { owner: signer.address },
      test2: { owner: signer.address },
      test3: { owner: signer.address },
    });
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
