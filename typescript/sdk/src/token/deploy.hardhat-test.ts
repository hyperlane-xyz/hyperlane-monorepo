import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import { expect } from 'chai';
import hre from 'hardhat';

import {
  ERC20Test,
  ERC20Test__factory,
  Mailbox,
  Mailbox__factory,
} from '@hyperlane-xyz/core';
import { Chains, RouterConfig } from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

import { TestCoreApp } from '../core/TestCoreApp.js';
import { TestCoreDeployer } from '../core/TestCoreDeployer.js';
import { EvmERC20WarpCrudModule } from '../crud/EvmWarpCrudModule.js';
import { HyperlaneProxyFactoryDeployer } from '../deploy/HyperlaneProxyFactoryDeployer.js';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainMap } from '../types.js';

import {
  // TokenRouterConfig,
  HypERC20CollateralConfig,
  HypERC20Config,
  TokenConfig,
  TokenType,
} from './config.js';
import { HypERC20Deployer } from './deploy.js';
import { EvmERC20WarpRouteReader } from './read.js';
import { TokenRouterConfig, WarpRouteDeployConfig } from './types.js';

describe.only('TokenDeployer', async () => {
  const TOKEN_NAME = 'fake';
  const TOKEN_SUPPLY = '100000000000000000000';
  const TOKEN_DECIMALS = 18;
  let erc20Factory: ERC20Test__factory;
  let token: ERC20Test;
  let signer: SignerWithAddress;
  let deployer: HypERC20Deployer;
  let multiProvider: MultiProvider;
  let coreApp: TestCoreApp;
  let routerConfigMap: ChainMap<RouterConfig>;
  let config: WarpRouteDeployConfig;
  let baseConfig: RouterConfig;

  before(async () => {
    [signer] = await hre.ethers.getSigners();
    multiProvider = MultiProvider.createTestMultiProvider({ signer });
    const ismFactoryDeployer = new HyperlaneProxyFactoryDeployer(multiProvider);
    const factories = await ismFactoryDeployer.deploy(
      multiProvider.mapKnownChains(() => ({})),
    );
    const ismFactory = new HyperlaneIsmFactory(factories, multiProvider);
    coreApp = await new TestCoreDeployer(multiProvider, ismFactory).deployApp();
    routerConfigMap = coreApp.getRouterConfig(signer.address);
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

    erc20Factory = new ERC20Test__factory(signer);
    token = await erc20Factory.deploy(
      TOKEN_NAME,
      TOKEN_NAME,
      TOKEN_SUPPLY,
      TOKEN_DECIMALS,
    );

    baseConfig = routerConfigMap[Chains.test1];
  });

  beforeEach(async () => {
    deployer = new HypERC20Deployer(multiProvider);
  });

  it('deploys', async () => {
    await deployer.deploy(config as ChainMap<TokenConfig & RouterConfig>);
  });

  describe('ERC20WarpRouterReader', async () => {
    let config: WarpRouteDeployConfig;
    let mailbox: Mailbox;
    let warpRoute: any;

    before(async () => {
      mailbox = Mailbox__factory.connect(baseConfig.mailbox, signer);
    });

    async function deriveWarpConfig(chainName: string, address: string) {
      return new EvmERC20WarpRouteReader(
        multiProvider,
        chainName,
      ).deriveWarpRouteConfig(address);
    }
    it('should derive TokenRouterConfig from collateral correctly', async () => {
      // Create config
      config = {
        [Chains.test1]: {
          type: TokenType.collateral,
          token: token.address,
          hook: await mailbox.defaultHook(),
          ...baseConfig,
        },
      };
      // Deploy with config
      warpRoute = await deployer.deploy(
        config as ChainMap<TokenConfig & RouterConfig>,
      );

      // Derive config and check if each value matches
      const derivedConfig: Partial<HypERC20CollateralConfig> =
        await deriveWarpConfig(
          Chains.test1,
          warpRoute[Chains.test1].collateral.address,
        );

      for (const [key, value] of Object.entries(derivedConfig)) {
        const deployedValue = (config[Chains.test1] as any)[key];
        if (deployedValue) expect(deployedValue).to.equal(value);
      }

      // Check if token values matches
      expect(derivedConfig.name).to.equal(TOKEN_NAME);
      expect(derivedConfig.symbol).to.equal(TOKEN_NAME);
      expect(derivedConfig.decimals).to.equal(TOKEN_DECIMALS);
    });
  });

  describe('EvmERC20WarpRouteReader', async () => {
    let evmERC20WarpCrudModule: EvmERC20WarpCrudModule;

    let mailbox: Mailbox;
    before(async () => {
      mailbox = Mailbox__factory.connect(baseConfig.mailbox, signer);
      evmERC20WarpCrudModule = new EvmERC20WarpCrudModule(multiProvider, {
        addresses: {},
        chain: Chains.test1,
        chainMetadataManager,
        config: {},
      });
    });
    describe('Create', async () => {
      it('should create with a config', async () => {
        const config: TokenRouterConfig = {
          type: TokenType.collateral,
          token: token.address,
          hook: await mailbox.defaultHook(),
          ...baseConfig,
        };

        await evmERC20WarpCrudModule.create(config);

        // Take a config, pass it into create, it should deploy
      });
      // it('should create with an ISM string', async () => {
      // });
      // it('should create with an hook config');
      // it('should create with an hook string');
    });

    // describe('Read', async () => {});

    // describe('Update', async () => {
    //   it('should update with an ISM string');
    //   it('should update with an ISM object');
    //   it('should update with an hook string');
    //   // it('should update with an hook object');
    // });
  });
});
