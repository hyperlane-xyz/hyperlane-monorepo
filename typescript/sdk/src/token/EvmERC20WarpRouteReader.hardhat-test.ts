import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';
import { zeroAddress } from 'viem';

import {
  ERC20Test,
  ERC20Test__factory,
  ERC4626,
  ERC4626Test__factory,
  FiatTokenTest,
  FiatTokenTest__factory,
  Mailbox,
  Mailbox__factory,
  XERC20LockboxTest__factory,
  XERC20Test__factory,
} from '@hyperlane-xyz/core';
import {
  HyperlaneContractsMap,
  RouterConfig,
  TestChainName,
  WarpRouteDeployConfigMailboxRequired,
  test3,
} from '@hyperlane-xyz/sdk';
import { addressToBytes32, assert } from '@hyperlane-xyz/utils';

import { TestCoreApp } from '../core/TestCoreApp.js';
import { TestCoreDeployer } from '../core/TestCoreDeployer.js';
import { HyperlaneProxyFactoryDeployer } from '../deploy/HyperlaneProxyFactoryDeployer.js';
import { ProxyFactoryFactories } from '../deploy/contracts.js';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainMap } from '../types.js';

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
  let token: ERC20Test;
  let signer: SignerWithAddress;
  let deployer: HypERC20Deployer;
  let multiProvider: MultiProvider;
  let coreApp: TestCoreApp;
  let routerConfigMap: ChainMap<RouterConfig>;
  let baseConfig: RouterConfig;
  let mailbox: Mailbox;
  let evmERC20WarpRouteReader: EvmERC20WarpRouteReader;
  let vault: ERC4626;
  let collateralFiatToken: FiatTokenTest;
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
    mailbox = Mailbox__factory.connect(baseConfig.mailbox, signer);
    evmERC20WarpRouteReader = new EvmERC20WarpRouteReader(multiProvider, chain);
    deployer = new HypERC20Deployer(multiProvider);

    const vaultFactory = new ERC4626Test__factory(signer);
    vault = await vaultFactory.deploy(token.address, TOKEN_NAME, TOKEN_NAME);

    const fiatCollateralFactory = new FiatTokenTest__factory(signer);
    collateralFiatToken = await fiatCollateralFactory.deploy(
      TOKEN_NAME,
      TOKEN_NAME,
      TOKEN_SUPPLY,
      TOKEN_DECIMALS,
    );
  });

  beforeEach(async () => {
    // Reset the MultiProvider and create a new deployer for each test
    multiProvider = MultiProvider.createTestMultiProvider({ signer });
    deployer = new HypERC20Deployer(multiProvider);
  });

  it('should derive a token type from contract', async () => {
    const typesToDerive = [
      TokenType.collateral,
      TokenType.collateralVault,
      TokenType.synthetic,
      TokenType.native,
    ] as const;

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
            gas: GAS,
            ...baseConfig,
          },
        };
        // Deploy warp route with config
        const warpRoute = await deployer.deploy(config);
        const derivedTokenType = await evmERC20WarpRouteReader.deriveTokenType(
          warpRoute[chain][type].address,
        );
        expect(derivedTokenType).to.equal(type);
      }),
    );
  });

  it('should derive collateral config correctly', async () => {
    // Create config
    const config: WarpRouteDeployConfigMailboxRequired = {
      [chain]: {
        type: TokenType.collateral,
        token: token.address,
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

    expect(derivedConfig.hook).to.equal(ethers.constants.AddressZero);
    expect(derivedConfig.interchainSecurityModule).to.equal(
      ethers.constants.AddressZero,
    );

    // Check if token values matches
    if (derivedConfig.type === TokenType.collateral) {
      expect(derivedConfig.name).to.equal(TOKEN_NAME);
      expect(derivedConfig.symbol).to.equal(TOKEN_NAME);
      expect(derivedConfig.decimals).to.equal(TOKEN_DECIMALS);
    }
  });

  it('should derive xerc20 config correctly', async () => {
    // Create token
    const xerc20Token = await new XERC20Test__factory(signer).deploy(
      TOKEN_NAME,
      TOKEN_NAME,
      TOKEN_SUPPLY,
      TOKEN_DECIMALS,
    );
    // Create config
    const config: WarpRouteDeployConfigMailboxRequired = {
      [chain]: {
        type: TokenType.XERC20,
        token: xerc20Token.address,
        hook: await mailbox.defaultHook(),
        interchainSecurityModule: await mailbox.defaultIsm(),
        ...baseConfig,
      },
    };
    // Deploy with config
    const warpRoute = await deployer.deploy(config);

    // Derive config and check if each value matches
    const derivedConfig = await evmERC20WarpRouteReader.deriveWarpRouteConfig(
      warpRoute[chain].xERC20.address,
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
    // Check ism
    expect(derivedConfig.interchainSecurityModule).to.be.equal(
      ethers.constants.AddressZero,
    );

    // Check if token values matches
    if (derivedConfig.type === TokenType.XERC20) {
      expect(derivedConfig.name).to.equal(TOKEN_NAME);
      expect(derivedConfig.symbol).to.equal(TOKEN_NAME);
      expect(derivedConfig.decimals).to.equal(TOKEN_DECIMALS);
      expect(derivedConfig.token).to.equal(xerc20Token.address);
    }
  });

  it('should derive xerc20lockbox config correctly', async () => {
    // Create token
    const xerc20Lockbox = await new XERC20LockboxTest__factory(signer).deploy(
      TOKEN_NAME,
      TOKEN_NAME,
      TOKEN_SUPPLY,
      TOKEN_DECIMALS,
    );
    // Create config
    const config: WarpRouteDeployConfigMailboxRequired = {
      [chain]: {
        type: TokenType.XERC20Lockbox,
        token: xerc20Lockbox.address,
        hook: await mailbox.defaultHook(),
        interchainSecurityModule: await mailbox.defaultIsm(),
        ...baseConfig,
      },
    };
    // Deploy with config
    const warpRoute = await deployer.deploy(config);
    // Derive config and check if each value matches
    const derivedConfig = await evmERC20WarpRouteReader.deriveWarpRouteConfig(
      warpRoute[chain].xERC20Lockbox.address,
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
    // Check ism
    expect(derivedConfig.interchainSecurityModule).to.be.equal(
      ethers.constants.AddressZero,
    );

    // Check if token values matches
    if (derivedConfig.type === TokenType.XERC20) {
      expect(derivedConfig.name).to.equal(TOKEN_NAME);
      expect(derivedConfig.symbol).to.equal(TOKEN_NAME);
      expect(derivedConfig.decimals).to.equal(TOKEN_DECIMALS);
      expect(derivedConfig.token).to.equal(xerc20Lockbox.address);
    }
  });

  it('should derive synthetic rebase config correctly', async () => {
    // Create config
    const config: WarpRouteDeployConfigMailboxRequired = {
      [chain]: {
        type: TokenType.syntheticRebase,
        collateralChainName: TestChainName.test4,
        hook: await mailbox.defaultHook(),
        name: TOKEN_NAME,
        symbol: TOKEN_NAME,
        decimals: TOKEN_DECIMALS,
        ...baseConfig,
      },
    };
    // Deploy with config
    const warpRoute = await deployer.deploy(config);

    // Derive config and check if each value matches
    const derivedConfig = await evmERC20WarpRouteReader.deriveWarpRouteConfig(
      warpRoute[chain].syntheticRebase.address,
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

  it('should derive synthetic config correctly', async () => {
    // Create config
    const config: WarpRouteDeployConfigMailboxRequired = {
      [chain]: {
        type: TokenType.synthetic,
        hook: await mailbox.defaultHook(),
        name: TOKEN_NAME,
        symbol: TOKEN_NAME,
        decimals: TOKEN_DECIMALS,
        initialSupply: TOKEN_SUPPLY,
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
    const config: WarpRouteDeployConfigMailboxRequired = {
      [chain]: {
        type: TokenType.native,
        hook: await mailbox.defaultHook(),
        ...baseConfig,
      },
    };
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

  it('should derive collateral vault config correctly', async () => {
    // Create config
    const config: WarpRouteDeployConfigMailboxRequired = {
      [chain]: {
        type: TokenType.collateralVault,
        token: vault.address,
        ...baseConfig,
      },
    };
    // Deploy with config
    const warpRoute = await deployer.deploy(config);
    // Derive config and check if each value matches
    const derivedConfig = await evmERC20WarpRouteReader.deriveWarpRouteConfig(
      warpRoute[chain].collateralVault.address,
    );

    assert(
      derivedConfig.type === TokenType.collateralVault,
      'Must be collateralVault',
    );
    expect(derivedConfig.type).to.equal(config[chain].type);
    expect(derivedConfig.mailbox).to.equal(config[chain].mailbox);
    expect(derivedConfig.owner).to.equal(config[chain].owner);
    expect(derivedConfig.token).to.equal(token.address);
  });

  it('should derive rebase collateral vault config correctly', async () => {
    // Create config
    const config: WarpRouteDeployConfigMailboxRequired = {
      [chain]: {
        type: TokenType.collateralVaultRebase,
        token: vault.address,
        ...baseConfig,
      },
    };
    // Deploy with config
    const warpRoute = await deployer.deploy(config);
    // Derive config and check if each value matches
    const derivedConfig = await evmERC20WarpRouteReader.deriveWarpRouteConfig(
      warpRoute[chain].collateralVaultRebase.address,
    );

    assert(
      derivedConfig.type === TokenType.collateralVaultRebase,
      'Must be collateralVaultRebase',
    );
    expect(derivedConfig.type).to.equal(config[chain].type);
    expect(derivedConfig.mailbox).to.equal(config[chain].mailbox);
    expect(derivedConfig.owner).to.equal(config[chain].owner);
    expect(derivedConfig.token).to.equal(token.address);
  });

  // FiatTokenTest
  it('should derive collateral fiat token type correctly', async () => {
    // Create config
    const config: WarpRouteDeployConfigMailboxRequired = {
      [chain]: {
        type: TokenType.collateralFiat,
        token: collateralFiatToken.address,
        ...baseConfig,
      },
    };
    // Deploy with config
    const warpRoute = await deployer.deploy(config);
    // Derive config and check if each value matches
    const derivedConfig = await evmERC20WarpRouteReader.deriveWarpRouteConfig(
      warpRoute[chain].collateralFiat.address,
    );

    assert(
      derivedConfig.type === TokenType.collateralFiat,
      `Must be ${TokenType.collateralFiat}`,
    );
    expect(derivedConfig.type).to.equal(config[chain].type);
    expect(derivedConfig.mailbox).to.equal(config[chain].mailbox);
    expect(derivedConfig.owner).to.equal(config[chain].owner);
    expect(derivedConfig.token).to.equal(collateralFiatToken.address);
  });

  it('should return 0x0 if ism is not set onchain', async () => {
    // Create config
    const config: WarpRouteDeployConfigMailboxRequired = {
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

    expect(derivedConfig.interchainSecurityModule).to.be.equal(zeroAddress);
  });

  it('should return the remote routers', async () => {
    // Create config
    const otherChain = TestChainName.test3;
    const otherChainMetadata = test3;
    const config: WarpRouteDeployConfigMailboxRequired = {
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
      derivedConfig.remoteRouters![otherChainMetadata.domainId!].address,
    ).to.be.equal(addressToBytes32(warpRoute[otherChain].collateral.address));
  });
});
