import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { ethers } from 'hardhat';

import { objMap } from '@hyperlane-xyz/utils';

import { TestCoreApp } from '../core/TestCoreApp';
import { TestCoreDeployer } from '../core/TestCoreDeployer';
import { HyperlaneProxyFactoryDeployer } from '../deploy/HyperlaneProxyFactoryDeployer';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainMap } from '../types';

import { ERC20RouterConfig, HypERC20Config, TokenType } from './config';
import { HypERC20Deployer } from './deploy';

describe('TokenDeployer', async () => {
  let signer: SignerWithAddress;
  let deployer: HypERC20Deployer;
  let multiProvider: MultiProvider;
  let coreApp: TestCoreApp;
  let config: ChainMap<ERC20RouterConfig>;

  before(async () => {
    [signer] = await ethers.getSigners();
    multiProvider = MultiProvider.createTestMultiProvider({ signer });
    const ismFactoryDeployer = new HyperlaneProxyFactoryDeployer(multiProvider);
    const factories = await ismFactoryDeployer.deploy(
      multiProvider.mapKnownChains(() => ({})),
    );
    const ismFactory = new HyperlaneIsmFactory(factories, multiProvider);
    coreApp = await new TestCoreDeployer(multiProvider, ismFactory).deployApp();
    const routerConfigMap = coreApp.getRouterConfig(signer.address);
    config = objMap(
      routerConfigMap,
      (chain, c): HypERC20Config => ({
        type: TokenType.synthetic,
        name: chain,
        symbol: `u${chain}`,
        decimals: 18,
        totalSupply: 100_000,
        gas: 65_000,
        ...c,
      }),
    );
  });

  beforeEach(async () => {
    deployer = new HypERC20Deployer(multiProvider);
  });

  it('deploys', async () => {
    await deployer.deploy(config);
  });
});
