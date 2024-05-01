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
  CollateralConfig,
  HypERC20Config,
  TokenConfig,
  TokenType,
} from './config.js';
import { HypERC20Deployer } from './deploy.js';
import { DerivedTokenType, EvmERC20WarpRouteReader } from './read.js';
import { TokenRouterConfig, WarpRouteDeployConfig } from './types.js';

describe.only('TokenDeployer', async () => {
  const TOKEN_NAME = 'fake';
  const TOKEN_SUPPLY = '100000000000000000000';
  const TOKEN_DECIMALS = 18;
  const GAS = 65_000;
  const chain = Chains.test1;
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
    routerConfigMap = coreApp.getRouterConfig(signer.address);
    config = objMap(
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
    let mailbox: Mailbox;
    let evmERC20WarpRouteReader: EvmERC20WarpRouteReader;

    before(async () => {
      mailbox = Mailbox__factory.connect(baseConfig.mailbox, signer);
      evmERC20WarpRouteReader = new EvmERC20WarpRouteReader(
        multiProvider,
        chain,
      );
    });

    it('should derive a token type from contract', async () => {
      const typesToDerive: DerivedTokenType[] = [
        TokenType.collateral,
        // TokenType.collateralVault, @todo add collateralVault by deploying a vault instead of erc20
        TokenType.synthetic,
        TokenType.native,
      ];

      await Promise.all(
        typesToDerive.map(async (type) => {
          // Create config
          const config = {
            [Chains.test1]: {
              type,
              token: token.address,
              hook: await mailbox.defaultHook(),
              name: TOKEN_NAME,
              symbol: TOKEN_NAME,
              decimals: TOKEN_DECIMALS,
              totalSupply: TOKEN_SUPPLY,
              gas: GAS,
              ...baseConfig,
            },
          };
          // Deploy warp route with config
          const warpRoute = await deployer.deploy(
            config as ChainMap<TokenConfig & RouterConfig>,
          );
          const derivedTokenType =
            await evmERC20WarpRouteReader.deriveTokenType(
              warpRoute[chain][type].address,
            );
          expect(derivedTokenType).to.equal(type);
        }),
      );
    });

    it('should derive config from collateral correctly', async () => {
      // Create config
      const config = {
        [Chains.test1]: {
          type: TokenType.collateral,
          token: token.address,
          hook: await mailbox.defaultHook(),
          ...baseConfig,
        },
      };
      // Deploy with config
      const warpRoute = await deployer.deploy(
        config as ChainMap<TokenConfig & RouterConfig>,
      );

      // Derive config and check if each value matches
      const derivedConfig =
        (await evmERC20WarpRouteReader.deriveWarpRouteConfig(
          warpRoute[Chains.test1].collateral.address,
        )) as CollateralConfig;

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
    let config: TokenRouterConfig;
    let mailbox: Mailbox;

    before(async () => {
      mailbox = Mailbox__factory.connect(baseConfig.mailbox, signer);
    });
    describe('Create', async () => {
      it('should create with a config', async () => {
        // Create config and deploy using WarpCrudModule
        config = {
          type: TokenType.collateral,
          token: token.address,
          hook: await mailbox.defaultHook(),
          ...baseConfig,
        };
        const evmERC20WarpCrudModule = await EvmERC20WarpCrudModule.create({
          chain,
          config,
          multiProvider,
        });

        // Let's derive it's onchain token type
        const { collateral } = evmERC20WarpCrudModule.serialize();
        const tokenType: TokenType =
          await evmERC20WarpCrudModule.reader.deriveTokenType(
            collateral.address,
          );
        expect(tokenType).to.equal(TokenType.collateral);
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
