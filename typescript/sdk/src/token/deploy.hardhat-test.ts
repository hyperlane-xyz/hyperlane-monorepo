import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import hre from 'hardhat';

import {
  ERC20Test,
  ERC20Test__factory,
  Mailbox,
  Mailbox__factory,
} from '@hyperlane-xyz/core';
import {
  HyperlaneContractsMap,
  RouterConfig,
  TestChainName,
} from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

import { TestCoreApp } from '../core/TestCoreApp.js';
import { TestCoreDeployer } from '../core/TestCoreDeployer.js';
import { HyperlaneProxyFactoryDeployer } from '../deploy/HyperlaneProxyFactoryDeployer.js';
import { ProxyFactoryFactories } from '../deploy/contracts.js';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainMap } from '../types.js';

import { DerivedTokenRouterConfig } from './EvmERC20WarpRouteReader.js';
import { HypERC20Config, TokenConfig, TokenType } from './config.js';
import { HypERC20Deployer } from './deploy.js';

describe('TokenDeployer', async () => {
  const TOKEN_NAME = 'fake';
  const TOKEN_SUPPLY = '100000000000000000000';
  const TOKEN_DECIMALS = 18;
  const GAS = 65_000;
  const chain = TestChainName.test4;
  let mailbox: Mailbox;
  let ismFactory: HyperlaneIsmFactory;
  let factories: HyperlaneContractsMap<ProxyFactoryFactories>;
  let erc20Factory: ERC20Test__factory;
  let token: ERC20Test;
  let signer: SignerWithAddress;
  let deployer: HypERC20Deployer;
  let multiProvider: MultiProvider;
  let coreApp: TestCoreApp;
  let routerConfigMap: ChainMap<RouterConfig>;
  let config: DerivedTokenRouterConfig;
  let baseConfig: RouterConfig;

  before(async () => {
    [signer] = await hre.ethers.getSigners();
    multiProvider = MultiProvider.createTestMultiProvider({ signer });
    const ismFactoryDeployer = new HyperlaneProxyFactoryDeployer(multiProvider);
    factories = await ismFactoryDeployer.deploy(
      multiProvider.mapKnownChains(() => ({})),
    );
    ismFactory = new HyperlaneIsmFactory(factories, multiProvider);
    coreApp = await new TestCoreDeployer(multiProvider, ismFactory).deployApp();
    routerConfigMap = coreApp.getRouterConfig(signer.address);

    erc20Factory = new ERC20Test__factory(signer);
    token = await erc20Factory.deploy(
      TOKEN_NAME,
      TOKEN_NAME,
      TOKEN_SUPPLY,
      TOKEN_DECIMALS,
    );

    baseConfig = routerConfigMap[chain];
    deployer = new HypERC20Deployer(multiProvider);

    mailbox = Mailbox__factory.connect(baseConfig.mailbox, signer);
    config = {
      type: TokenType.collateral,
      token: token.address,
      hook: await mailbox.defaultHook(),
      ...baseConfig,
    } as DerivedTokenRouterConfig;
  });

  it('deploys', async () => {
    const config = objMap(
      routerConfigMap,
      (chain, c): HypERC20Config => ({
        type: TokenType.synthetic,
        name: chain,
        symbol: `u${chain}`,
        decimals: TOKEN_DECIMALS,
        totalSupply: TOKEN_SUPPLY,
        gas: GAS,
        ...c,
      }),
    );
    await deployer.deploy(config as ChainMap<TokenConfig & RouterConfig>);
  });
});
