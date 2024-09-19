import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import { expect } from 'chai';
import hre from 'hardhat';
import { Contract, Provider, Wallet } from 'zksync-ethers';

import {
  ERC20Test,
  ERC20Test__factory,
  ERC4626,
  ERC4626Test__factory,
  Mailbox,
  Mailbox__factory,
} from '@hyperlane-xyz/core';
import {
  ERC20Test__artifact,
  ERC4626Test__artifact,
} from '@hyperlane-xyz/core/artifacts';
import {
  HyperlaneContractsMap,
  RouterConfig,
  TestChainName,
  TokenRouterConfig,
  test3,
} from '@hyperlane-xyz/sdk';

import { TestCoreApp } from '../core/TestCoreApp.js';
import { TestCoreDeployer } from '../core/TestCoreDeployer.js';
import { HyperlaneProxyFactoryDeployer } from '../deploy/HyperlaneProxyFactoryDeployer.js';
import { ProxyFactoryFactories } from '../deploy/contracts.js';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainMap } from '../types.js';
import { ZKDeployer } from '../zksync/ZKDeployer.js';

import { EvmERC20WarpRouteReader } from './EvmERC20WarpRouteReader.js';
import { TokenType } from './config.js';
import { HypERC20Deployer } from './deploy.js';

describe('ERC20WarpRouterReader', async () => {
  const TOKEN_NAME = 'fake';
  const TOKEN_SUPPLY = '100000000000000000000';
  const TOKEN_DECIMALS = 18;
  const GAS = 65_000;
  const chain = TestChainName.test4;
  let ismFactory: HyperlaneIsmFactory;
  let factories: HyperlaneContractsMap<ProxyFactoryFactories>;
  let erc20Factory: ERC20Test__factory;
  let token: Contract;
  let signer: Wallet;
  let deployer: HypERC20Deployer;
  let zkDeployer: any;
  let multiProvider: MultiProvider;
  let coreApp: TestCoreApp;
  let routerConfigMap: ChainMap<RouterConfig>;
  let baseConfig: RouterConfig;
  let mailbox: Mailbox;
  let evmERC20WarpRouteReader: EvmERC20WarpRouteReader;
  let vault: Contract;

  beforeEach(async () => {
    const prov = new Provider('http://127.0.0.1:8011', 260);

    signer = new Wallet(
      '0x3d3cbc973389cb26f657686445bcc75662b415b656078503592ac8c1abb8810e',
      prov,
    );

    zkDeployer = new ZKDeployer(signer);
    deployer = new HypERC20Deployer(multiProvider);

    multiProvider = MultiProvider.createTestMultiProvider({ signer });

    const ismFactoryDeployer = new HyperlaneProxyFactoryDeployer(multiProvider);
    factories = await ismFactoryDeployer.deploy(
      multiProvider.mapKnownChains(() => ({})),
    );

    ismFactory = new HyperlaneIsmFactory(factories, multiProvider);
    coreApp = await new TestCoreDeployer(multiProvider, ismFactory).deployApp();

    routerConfigMap = coreApp.getRouterConfig(signer.address);

    token = await zkDeployer.deploy(ERC20Test__artifact, [
      TOKEN_NAME,
      TOKEN_NAME,
      TOKEN_SUPPLY,
      TOKEN_DECIMALS,
    ]);

    baseConfig = routerConfigMap[chain];

    mailbox = Mailbox__factory.connect(baseConfig.mailbox, signer);
    evmERC20WarpRouteReader = new EvmERC20WarpRouteReader(multiProvider, chain);

    vault = await zkDeployer.deploy(ERC4626Test__artifact, [
      token.address,
      TOKEN_NAME,
      TOKEN_NAME,
    ]);
  });

  it('should derive a token type from contract', async () => {
    console.log('inside derivation');

    const typesToDerive = [
      TokenType.collateral,
      TokenType.collateralVault,
      TokenType.synthetic,
      TokenType.native,
    ] as const;
    console.log('before derivation');
    await Promise.all(
      typesToDerive.map(async (type) => {
        // Create config
        const config = {
          [chain]: {
            type,
            token:
              type === TokenType.collateralVault
                ? vault.address
                : token.address,
            hook: await mailbox.defaultHook(),
            name: TOKEN_NAME,
            symbol: TOKEN_NAME,
            decimals: TOKEN_DECIMALS,
            totalSupply: TOKEN_SUPPLY,
            gas: GAS,
            ...baseConfig,
          },
        };
        console.log('bf warpRoute');
        // Deploy warp route with config
        const warpRoute = await deployer.deploy(config);
        const derivedTokenType = await evmERC20WarpRouteReader.deriveTokenType(
          warpRoute[chain][type].address,
        );
        console.log('af warpRoute');
        expect(derivedTokenType).to.equal(type);
      }),
    );
    console.log('after derivation');
  });

  it('should derive collateral config correctly', async () => {
    // Create config
    const config = {
      [chain]: {
        type: TokenType.collateral,
        token: token.address,
        hook: await mailbox.defaultHook(),
        interchainsecurityModule: await mailbox.defaultIsm(),
        ...baseConfig,
      },
    };
    // Deploy with config
    const warpRoute = await deployer.deploy(config);

    // Derive config and check if each value matches
    const derivedConfig = await evmERC20WarpRouteReader.deriveWarpRouteConfig(
      warpRoute[chain].collateral.address,
    );
    for (const [key, value] of Object.entries(derivedConfig)) {
      const deployedValue = (config[chain] as any)[key];
      if (deployedValue && typeof value === 'string')
        expect(deployedValue).to.equal(value);
    }

    // Check hook because they're potentially objects
    expect(derivedConfig.hook).to.deep.equal(
      await evmERC20WarpRouteReader.evmHookReader.deriveHookConfig(
        config[chain].hook as string,
      ),
    );
    // Check ism. should return undefined
    expect(derivedConfig.interchainSecurityModule).to.be.undefined;

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
    const warpRoute = await deployer.deploy(config);

    // Derive config and check if each value matches
    const derivedConfig = await evmERC20WarpRouteReader.deriveWarpRouteConfig(
      warpRoute[chain].synthetic.address,
    );
    for (const [key, value] of Object.entries(derivedConfig)) {
      const deployedValue = (config[chain] as any)[key];
      if (deployedValue && typeof value === 'string')
        expect(deployedValue).to.equal(value);
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
    } as ChainMap<TokenRouterConfig>;
    // Deploy with config
    const warpRoute = await deployer.deploy(config);

    // Derive config and check if each value matches
    const derivedConfig = await evmERC20WarpRouteReader.deriveWarpRouteConfig(
      warpRoute[chain].native.address,
    );
    for (const [key, value] of Object.entries(derivedConfig)) {
      const deployedValue = (config[chain] as any)[key];
      if (deployedValue && typeof value === 'string')
        expect(deployedValue).to.equal(value);
    }

    // Check if token values matches
    expect(derivedConfig.decimals).to.equal(TOKEN_DECIMALS);
  });

  it('should return undefined if ism is not set onchain', async () => {
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
    const warpRoute = await deployer.deploy(config);

    // Derive config and check if each value matches
    const derivedConfig = await evmERC20WarpRouteReader.deriveWarpRouteConfig(
      warpRoute[chain].collateral.address,
    );

    expect(derivedConfig.interchainSecurityModule).to.be.undefined;
  });

  it('should return the remote routers', async () => {
    // Create config
    const otherChain = TestChainName.test3;
    const otherChainMetadata = test3;
    const config = {
      [chain]: {
        type: TokenType.collateral,
        token: token.address,
        hook: await mailbox.defaultHook(),
        ...baseConfig,
      },
      [otherChain]: {
        type: TokenType.collateral,
        token: token.address,
        hook: await mailbox.defaultHook(),
        ...baseConfig,
      },
    };
    // Deploy with config
    const warpRoute = await deployer.deploy(config);

    // Derive config and check if remote router matches
    const derivedConfig = await evmERC20WarpRouteReader.deriveWarpRouteConfig(
      warpRoute[chain].collateral.address,
    );
    expect(Object.keys(derivedConfig.remoteRouters!).length).to.equal(1);
    expect(
      derivedConfig.remoteRouters![otherChainMetadata.domainId!],
    ).to.be.equal(warpRoute[otherChain].collateral.address);
  });
});
