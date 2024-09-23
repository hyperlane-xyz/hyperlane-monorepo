import { expect } from 'chai';
import { Wallet } from 'zksync-ethers';

import { ERC20Test__artifact } from '@hyperlane-xyz/core/artifacts';
import { Address, objMap } from '@hyperlane-xyz/utils';

import { TestChainName } from '../consts/testChains.js';
import { TestCoreApp } from '../core/TestCoreApp.js';
import { TestCoreDeployer } from '../core/TestCoreDeployer.js';
import { HyperlaneProxyFactoryDeployer } from '../deploy/HyperlaneProxyFactoryDeployer.js';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ZKDeployer } from '../zksync/ZKDeployer.js';

import { EvmERC20WarpRouteReader } from './EvmERC20WarpRouteReader.js';
import { TokenType } from './config.js';
import { HypERC20Deployer } from './deploy.js';
import { TokenRouterConfig } from './schemas.js';
import { WarpRouteDeployConfig } from './types.js';

const chain = TestChainName.test1;

describe('TokenDeployer', async () => {
  let signer: Wallet;
  let deployer: HypERC20Deployer;
  let multiProvider: MultiProvider;
  let coreApp: TestCoreApp;
  let config: WarpRouteDeployConfig;
  let token: Address;

  before(async () => {
    signer = new Wallet(
      '0x3d3cbc973389cb26f657686445bcc75662b415b656078503592ac8c1abb8810e',
    );
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
      (chain, c): TokenRouterConfig => ({
        type: TokenType.synthetic,
        name: chain,
        symbol: `u${chain}`,
        decimals: 18,
        totalSupply: '100000',
        ...c,
      }),
    );

    const { name, decimals, symbol, totalSupply } = config[chain];

    const deployer = new ZKDeployer(signer);

    const contract = await deployer.deploy(ERC20Test__artifact, [
      name!,
      symbol!,
      totalSupply!,
      decimals!,
    ]);

    token = contract.address;
  });

  beforeEach(async () => {
    deployer = new HypERC20Deployer(multiProvider);
  });

  it('deploys', async () => {
    await deployer.deploy(config);
  });

  for (const type of [TokenType.collateral, TokenType.synthetic]) {
    describe('ERC20WarpRouterReader', async () => {
      let reader: EvmERC20WarpRouteReader;
      let routerAddress: Address;

      before(() => {
        reader = new EvmERC20WarpRouteReader(
          multiProvider,
          TestChainName.test1,
        );
      });

      beforeEach(async () => {
        config[chain] = {
          ...config[chain],
          type,
          // @ts-ignore
          token: type === TokenType.collateral ? token : undefined,
        };
        const warpRoute = await deployer.deploy(config);
        routerAddress = warpRoute[chain][type].address;
      });

      it(`should derive TokenRouterConfig correctly`, async () => {
        const derivedConfig = await reader.deriveWarpRouteConfig(routerAddress);
        expect(derivedConfig.type).to.equal(config[chain].type);
      });
    });
  }
});
