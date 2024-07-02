import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import { expect } from 'chai';
import { constants } from 'ethers';
import hre from 'hardhat';

import {
  ERC20Test,
  ERC20Test__factory,
  ERC4626Test__factory,
  GasRouter,
  HypERC20CollateralVaultDeposit__factory,
  HypERC20__factory,
  HypNative__factory,
  Mailbox,
  Mailbox__factory,
} from '@hyperlane-xyz/core';
import {
  HyperlaneContractsMap,
  IsmConfig,
  IsmType,
  RouterConfig,
  TestChainName,
} from '@hyperlane-xyz/sdk';
import { normalizeConfig } from '@hyperlane-xyz/utils';

import { TestCoreApp } from '../core/TestCoreApp.js';
import { TestCoreDeployer } from '../core/TestCoreDeployer.js';
import { HyperlaneProxyFactoryDeployer } from '../deploy/HyperlaneProxyFactoryDeployer.js';
import { ProxyFactoryFactories } from '../deploy/contracts.js';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { AnnotatedEV5Transaction } from '../providers/ProviderType.js';
import { randomAddress } from '../test/testUtils.js';
import { ChainMap } from '../types.js';

import { EvmERC20WarpModule } from './EvmERC20WarpModule.js';
import { TokenType } from './config.js';
import { TokenRouterConfig } from './schemas.js';

describe('EvmERC20WarpHyperlaneModule', async () => {
  const TOKEN_NAME = 'fake';
  const TOKEN_SUPPLY = '100000000000000000000';
  const TOKEN_DECIMALS = 18;
  const chain = TestChainName.test4;
  let mailbox: Mailbox;
  let hookAddress: string;
  let ismFactory: HyperlaneIsmFactory;
  let factories: HyperlaneContractsMap<ProxyFactoryFactories>;
  let erc20Factory: ERC20Test__factory;
  let token: ERC20Test;
  let signer: SignerWithAddress;
  let multiProvider: MultiProvider;
  let coreApp: TestCoreApp;
  let routerConfigMap: ChainMap<RouterConfig>;
  let baseConfig: RouterConfig;

  async function validateCoreValues(deployedToken: GasRouter) {
    expect(await deployedToken.mailbox()).to.equal(mailbox.address);
    expect(await deployedToken.hook()).to.equal(hookAddress);
    expect(await deployedToken.interchainSecurityModule()).to.equal(
      constants.AddressZero,
    );
    expect(await deployedToken.owner()).to.equal(signer.address);
  }

  async function sendTxs(txs: AnnotatedEV5Transaction[]) {
    for (const tx of txs) {
      await multiProvider.sendTransaction(chain, tx);
    }
  }

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
    hookAddress = await mailbox.defaultHook();
  });

  it('should create with a collateral config', async () => {
    const config = {
      ...baseConfig,
      type: TokenType.collateral,
      token: token.address,
      hook: hookAddress,
    };

    // Deploy using WarpModule
    const evmERC20WarpModule = await EvmERC20WarpModule.create({
      chain,
      config,
      multiProvider,
    });

    // Let's derive it's onchain token type
    const { deployedTokenRoute } = evmERC20WarpModule.serialize();
    const tokenType: TokenType =
      await evmERC20WarpModule.reader.deriveTokenType(deployedTokenRoute);
    expect(tokenType).to.equal(TokenType.collateral);
  });

  it('should create with a collateral vault config', async () => {
    const vaultFactory = new ERC4626Test__factory(signer);
    const vault = await vaultFactory.deploy(
      token.address,
      TOKEN_NAME,
      TOKEN_NAME,
    );
    const config = {
      type: TokenType.collateralVault,
      token: vault.address,
      hook: hookAddress,
      ...baseConfig,
    };

    // Deploy using WarpModule
    const evmERC20WarpModule = await EvmERC20WarpModule.create({
      chain,
      config,
      multiProvider,
    });

    // Let's derive it's onchain token type
    const { deployedTokenRoute } = evmERC20WarpModule.serialize();
    const tokenType: TokenType =
      await evmERC20WarpModule.reader.deriveTokenType(deployedTokenRoute);
    expect(tokenType).to.equal(TokenType.collateralVault);

    // Validate onchain token values
    const collateralVaultContract =
      HypERC20CollateralVaultDeposit__factory.connect(
        deployedTokenRoute,
        signer,
      );
    await validateCoreValues(collateralVaultContract);
    expect(await collateralVaultContract.vault()).to.equal(vault.address);
    expect(await collateralVaultContract.wrappedToken()).to.equal(
      token.address,
    );
  });

  it('should create with a synthetic config', async () => {
    const config = {
      type: TokenType.synthetic,
      token: token.address,
      hook: hookAddress,
      name: TOKEN_NAME,
      symbol: TOKEN_NAME,
      decimals: TOKEN_DECIMALS,
      totalSupply: TOKEN_SUPPLY,
      ...baseConfig,
    };

    // Deploy using WarpModule
    const evmERC20WarpModule = await EvmERC20WarpModule.create({
      chain,
      config,
      multiProvider,
    });

    // Let's derive it's onchain token type
    const { deployedTokenRoute } = evmERC20WarpModule.serialize();
    const tokenType: TokenType =
      await evmERC20WarpModule.reader.deriveTokenType(deployedTokenRoute);
    expect(tokenType).to.equal(TokenType.synthetic);

    // Validate onchain token values
    const syntheticContract = HypERC20__factory.connect(
      deployedTokenRoute,
      signer,
    );
    await validateCoreValues(syntheticContract);
    expect(await syntheticContract.name()).to.equal(TOKEN_NAME);
    expect(await syntheticContract.symbol()).to.equal(TOKEN_NAME);
    expect(await syntheticContract.decimals()).to.equal(TOKEN_DECIMALS);
    expect(await syntheticContract.totalSupply()).to.equal(TOKEN_SUPPLY);
  });

  it('should create with a native config', async () => {
    const config = {
      type: TokenType.native,
      hook: hookAddress,
      ...baseConfig,
    } as TokenRouterConfig;

    // Deploy using WarpModule
    const evmERC20WarpModule = await EvmERC20WarpModule.create({
      chain,
      config,
      multiProvider,
    });

    // Let's derive it's onchain token type
    const { deployedTokenRoute } = evmERC20WarpModule.serialize();
    const tokenType: TokenType =
      await evmERC20WarpModule.reader.deriveTokenType(deployedTokenRoute);
    expect(tokenType).to.equal(TokenType.native);

    // Validate onchain token values
    const nativeContract = HypNative__factory.connect(
      deployedTokenRoute,
      signer,
    );
    await validateCoreValues(nativeContract);
  });

  describe('Update Ism', async () => {
    const ismConfigToUpdate: IsmConfig[] = [
      {
        type: IsmType.TRUSTED_RELAYER,
        relayer: randomAddress(),
      },
      {
        type: IsmType.FALLBACK_ROUTING,
        owner: randomAddress(),
        domains: {},
      },
      {
        type: IsmType.PAUSABLE,
        owner: randomAddress(),
        paused: false,
      },
      {
        type: IsmType.TEST_ISM,
      },
    ];
    it('should deploy and set a new Ism', async () => {
      const config = {
        type: TokenType.native,
        hook: hookAddress,
        ...baseConfig,
      } as TokenRouterConfig;

      // Deploy using WarpModule
      const evmERC20WarpModule = await EvmERC20WarpModule.create({
        chain,
        config,
        multiProvider,
      });
      const actualConfig = await evmERC20WarpModule.read();

      for (const interchainSecurityModule of ismConfigToUpdate) {
        const expectedConfig: TokenRouterConfig = {
          ...actualConfig,
          interchainSecurityModule,
        };

        await sendTxs(await evmERC20WarpModule.update(expectedConfig));

        const updatedConfig = normalizeConfig(
          (await evmERC20WarpModule.read()).interchainSecurityModule,
        );

        expect(updatedConfig).to.deep.equal(interchainSecurityModule);
      }
    });

    it('should not deployset a new Ism if the config is the same', async () => {
      const config = {
        type: TokenType.native,
        hook: hookAddress,
        ...baseConfig,
      } as TokenRouterConfig;

      // Deploy using WarpModule
      const evmERC20WarpModule = await EvmERC20WarpModule.create({
        chain,
        config,
        multiProvider,
      });
      const actualConfig = await evmERC20WarpModule.read();

      const owner = randomAddress();
      const interchainSecurityModule: IsmConfig = {
        type: IsmType.PAUSABLE,
        owner,
        paused: false,
      };
      const expectedConfig: TokenRouterConfig = {
        ...actualConfig,
        interchainSecurityModule: {
          type: IsmType.PAUSABLE,
          owner,
          paused: false,
        },
      };

      await sendTxs(await evmERC20WarpModule.update(expectedConfig));

      const updatedConfig = normalizeConfig(
        (await evmERC20WarpModule.read()).interchainSecurityModule,
      );

      expect(updatedConfig).to.deep.equal(interchainSecurityModule);

      // Deploy with the same config
      const txs = await evmERC20WarpModule.update(expectedConfig);

      expect(txs.length).to.equal(0);
    });
  });
});
