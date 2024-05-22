import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import { expect } from 'chai';
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

import { EvmERC20WarpModule } from './EvmERC20WarpModule.js';
import {
  DerivedTokenRouterConfig,
  DerivedTokenType,
  EvmERC20WarpRouteReader,
} from './EvmERC20WarpRouteReader.js';
import { HypERC20Config, TokenConfig, TokenType } from './config.js';
import { HypERC20Deployer } from './deploy.js';
import { WarpRouteDeployConfig } from './types.js';

describe('TokenDeployer', async () => {
  const TOKEN_NAME = 'fake';
  const TOKEN_SUPPLY = '100000000000000000000';
  const TOKEN_DECIMALS = 18;
  const GAS = 65_000;
  const chain = TestChainName.test4;
  let ismFactory: HyperlaneIsmFactory;
  let factories: HyperlaneContractsMap<ProxyFactoryFactories>;
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
    factories = await ismFactoryDeployer.deploy(
      multiProvider.mapKnownChains(() => ({})),
    );
    ismFactory = new HyperlaneIsmFactory(factories, multiProvider);
    coreApp = await new TestCoreDeployer(multiProvider, ismFactory).deployApp();
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

    baseConfig = routerConfigMap[chain];
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
            [chain]: {
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

    it('should derive collateral config correctly', async () => {
      // Create config
      const config = {
        [chain]: {
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
      const derivedConfig = await evmERC20WarpRouteReader.deriveWarpRouteConfig(
        warpRoute[chain].collateral.address,
      );
      for (const [key, value] of Object.entries(derivedConfig)) {
        const deployedValue = (config[chain] as any)[key];
        if (deployedValue) expect(deployedValue).to.equal(value);
      }

      // Check if token values matches
      if (derivedConfig.type === TokenType.collateral) {
        expect(derivedConfig.name).to.equal(TOKEN_NAME);
        expect(derivedConfig.symbol).to.equal(TOKEN_NAME);
        expect(derivedConfig.decimals).to.equal(TOKEN_DECIMALS);
      }
    });

    it('should derive synthetic config correctly', async () => {
      // Create config
      const config = {
        [chain]: {
          type: TokenType.synthetic,
          token: token.address,
          hook: await mailbox.defaultHook(),
          name: TOKEN_NAME,
          symbol: TOKEN_NAME,
          decimals: TOKEN_DECIMALS,
          totalSupply: TOKEN_SUPPLY,
          ...baseConfig,
        },
      };
      // Deploy with config
      const warpRoute = await deployer.deploy(
        config as ChainMap<TokenConfig & RouterConfig>,
      );

      // Derive config and check if each value matches
      const derivedConfig = await evmERC20WarpRouteReader.deriveWarpRouteConfig(
        warpRoute[chain].synthetic.address,
      );
      for (const [key, value] of Object.entries(derivedConfig)) {
        const deployedValue = (config[chain] as any)[key];
        if (deployedValue) expect(deployedValue).to.equal(value);
      }

      // Check if token values matches
      if (derivedConfig.type === TokenType.collateral) {
        expect(derivedConfig.name).to.equal(TOKEN_NAME);
        expect(derivedConfig.symbol).to.equal(TOKEN_NAME);
      }
    });

    it('should derive native config correctly', async () => {
      // Create config
      const config = {
        [chain]: {
          type: TokenType.native,
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
          warpRoute[chain].native.address,
        )) as Extract<DerivedTokenRouterConfig, { type: TokenType.native }>;
      for (const [key, value] of Object.entries(derivedConfig)) {
        const deployedValue = (config[chain] as any)[key];
        if (deployedValue) expect(deployedValue).to.equal(value);
      }

      // Check if token values matches
      expect(derivedConfig.decimals).to.equal(TOKEN_DECIMALS);
    });
  });

  describe('EvmERC20WarpHyperlaneModule', async () => {
    let config: any;
    let mailbox: Mailbox;

    before(async () => {
      mailbox = Mailbox__factory.connect(baseConfig.mailbox, signer);
      config = {
        type: TokenType.collateral,
        token: token.address,
        hook: await mailbox.defaultHook(),
        ...baseConfig,
      } as DerivedTokenRouterConfig;
    });
    describe('Create', async () => {
      it('should create with a config', async () => {
        // Deploy using WarpModule
        const evmERC20WarpModule = await EvmERC20WarpModule.create({
          chain,
          config,
          multiProvider,
        });

        // Let's derive it's onchain token type
        const { collateral } = evmERC20WarpModule.serialize();
        const tokenType: TokenType =
          await evmERC20WarpModule.reader.deriveTokenType(collateral.address);
        expect(tokenType).to.equal(TokenType.collateral);
      });
    });
  });
});
