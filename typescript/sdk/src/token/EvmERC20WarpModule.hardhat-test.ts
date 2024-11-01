import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import { expect } from 'chai';
import { constants } from 'ethers';
import hre from 'hardhat';

import {
  ERC20Test,
  ERC20Test__factory,
  ERC4626Test__factory,
  GasRouter,
  HypERC20__factory,
  HypERC4626Collateral__factory,
  HypNative__factory,
  Mailbox,
  Mailbox__factory,
} from '@hyperlane-xyz/core';
import {
  EvmIsmModule,
  HyperlaneAddresses,
  HyperlaneContractsMap,
  IsmConfig,
  IsmType,
  RouterConfig,
  TestChainName,
  serializeContracts,
} from '@hyperlane-xyz/sdk';

import { TestCoreApp } from '../core/TestCoreApp.js';
import { TestCoreDeployer } from '../core/TestCoreDeployer.js';
import { HyperlaneProxyFactoryDeployer } from '../deploy/HyperlaneProxyFactoryDeployer.js';
import { ProxyFactoryFactories } from '../deploy/contracts.js';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { AnnotatedEV5Transaction } from '../providers/ProviderType.js';
import { RemoteRouters } from '../router/types.js';
import { randomAddress } from '../test/testUtils.js';
import { ChainMap } from '../types.js';
import { normalizeConfig } from '../utils/ism.js';

import { EvmERC20WarpModule } from './EvmERC20WarpModule.js';
import { TokenType } from './config.js';
import { TokenRouterConfig } from './schemas.js';

const randomRemoteRouters = (n: number) => {
  const routers: RemoteRouters = {};
  for (let domain = 0; domain < n; domain++) {
    routers[domain] = randomAddress();
  }
  return routers;
};

describe('EvmERC20WarpHyperlaneModule', async () => {
  const TOKEN_NAME = 'fake';
  const TOKEN_SUPPLY = '100000000000000000000';
  const TOKEN_DECIMALS = 18;
  const chain = TestChainName.test4;
  let mailbox: Mailbox;
  let hookAddress: string;
  let ismAddress: string;
  let ismFactory: HyperlaneIsmFactory;
  let factories: HyperlaneContractsMap<ProxyFactoryFactories>;
  let ismFactoryAddresses: HyperlaneAddresses<ProxyFactoryFactories>;
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
    ismFactoryAddresses = serializeContracts(factories[chain]);
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
    ismAddress = await mailbox.defaultIsm();
  });

  it('should create with a collateral config', async () => {
    const config: TokenRouterConfig = {
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
    const config: TokenRouterConfig = {
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
    const collateralVaultContract = HypERC4626Collateral__factory.connect(
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
    const config: TokenRouterConfig = {
      type: TokenType.synthetic,
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

  it('should create with remote routers', async () => {
    const numOfRouters = Math.floor(Math.random() * 10);
    const config = {
      ...baseConfig,
      type: TokenType.native,
      hook: hookAddress,
      remoteRouters: randomRemoteRouters(numOfRouters),
    } as TokenRouterConfig;

    // Deploy using WarpModule
    const evmERC20WarpModule = await EvmERC20WarpModule.create({
      chain,
      config,
      multiProvider,
    });
    const { remoteRouters } = await evmERC20WarpModule.read();
    expect(Object.keys(remoteRouters!).length).to.equal(numOfRouters);
  });

  describe('Update', async () => {
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
    ];

    it('should deploy and set a new Ism', async () => {
      const config = {
        ...baseConfig,
        type: TokenType.native,
        hook: hookAddress,
        interchainSecurityModule: ismAddress,
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
          ismFactoryAddresses,
          interchainSecurityModule,
        };
        await sendTxs(await evmERC20WarpModule.update(expectedConfig));
        const updatedConfig = normalizeConfig(
          (await evmERC20WarpModule.read()).interchainSecurityModule,
        );

        expect(updatedConfig).to.deep.equal(interchainSecurityModule);
      }
    });

    it('should not deploy and set a new Ism if the config is the same', async () => {
      const config = {
        ...baseConfig,
        type: TokenType.native,
        hook: hookAddress,
        interchainSecurityModule: ismAddress,
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
        ismFactoryAddresses,
        interchainSecurityModule,
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

    it('should update a mutable Ism', async () => {
      const ismConfig: IsmConfig = {
        type: IsmType.ROUTING,
        owner: signer.address,
        domains: {
          '1': ismAddress,
        },
      };
      const ism = await EvmIsmModule.create({
        chain,
        multiProvider,
        config: ismConfig,
        proxyFactoryFactories: ismFactoryAddresses,
        mailbox: mailbox.address,
      });

      const { deployedIsm } = ism.serialize();
      // Deploy using WarpModule
      const config = {
        ...baseConfig,
        type: TokenType.native,
        hook: hookAddress,
        interchainSecurityModule: deployedIsm,
      } as TokenRouterConfig;

      const evmERC20WarpModule = await EvmERC20WarpModule.create({
        chain,
        config,
        multiProvider,
      });
      const actualConfig = await evmERC20WarpModule.read();
      const expectedConfig: TokenRouterConfig = {
        ...actualConfig,
        ismFactoryAddresses,
        interchainSecurityModule: {
          type: IsmType.ROUTING,
          owner: randomAddress(),
          domains: {
            test2: { type: IsmType.TEST_ISM },
          },
        },
      };

      await sendTxs(await evmERC20WarpModule.update(expectedConfig));

      const updatedConfig = normalizeConfig(
        (await evmERC20WarpModule.read()).interchainSecurityModule,
      );

      expect(updatedConfig).to.deep.equal(
        expectedConfig.interchainSecurityModule,
      );
    });

    it('should update connected routers', async () => {
      const config = {
        ...baseConfig,
        type: TokenType.native,
        hook: hookAddress,
        ismFactoryAddresses,
      } as TokenRouterConfig;

      // Deploy using WarpModule
      const evmERC20WarpModule = await EvmERC20WarpModule.create({
        chain,
        config: {
          ...config,
          interchainSecurityModule: ismAddress,
        },
        multiProvider,
      });
      const numOfRouters = Math.floor(Math.random() * 10);
      await sendTxs(
        await evmERC20WarpModule.update({
          ...config,
          remoteRouters: randomRemoteRouters(numOfRouters),
        }),
      );

      const updatedConfig = await evmERC20WarpModule.read();
      expect(Object.keys(updatedConfig.remoteRouters!).length).to.be.equal(
        numOfRouters,
      );
    });

    it('should only extend routers if they are new ones are different', async () => {
      const config = {
        ...baseConfig,
        type: TokenType.native,
        hook: hookAddress,
        ismFactoryAddresses,
      } as TokenRouterConfig;

      // Deploy using WarpModule
      const evmERC20WarpModule = await EvmERC20WarpModule.create({
        chain,
        config: {
          ...config,
          interchainSecurityModule: ismAddress,
        },
        multiProvider,
      });
      const remoteRouters = randomRemoteRouters(1);
      await sendTxs(
        await evmERC20WarpModule.update({
          ...config,
          remoteRouters,
        }),
      );

      let updatedConfig = await evmERC20WarpModule.read();
      expect(Object.keys(updatedConfig.remoteRouters!).length).to.be.equal(1);

      // Try to extend with the same remoteRouters
      let txs = await evmERC20WarpModule.update({
        ...config,
        remoteRouters,
      });

      expect(txs.length).to.equal(0);
      await sendTxs(txs);

      // Try to extend with the different remoteRouters, but same length
      txs = await evmERC20WarpModule.update({
        ...config,
        remoteRouters: {
          3: randomAddress(),
        },
      });

      expect(txs.length).to.equal(1);
      await sendTxs(txs);

      updatedConfig = await evmERC20WarpModule.read();
      expect(Object.keys(updatedConfig.remoteRouters!).length).to.be.equal(2);
    });

    it('should update the owner only if they are different', async () => {
      const config = {
        ...baseConfig,
        type: TokenType.native,
        hook: hookAddress,
        ismFactoryAddresses,
      } as TokenRouterConfig;

      const owner = signer.address.toLowerCase();
      const evmERC20WarpModule = await EvmERC20WarpModule.create({
        chain,
        config: {
          ...config,
          interchainSecurityModule: ismAddress,
        },
        multiProvider,
      });

      const currentConfig = await evmERC20WarpModule.read();
      expect(currentConfig.owner.toLowerCase()).to.equal(owner);

      const newOwner = randomAddress();
      await sendTxs(
        await evmERC20WarpModule.update({
          ...config,
          owner: newOwner,
        }),
      );

      const latestConfig = normalizeConfig(await evmERC20WarpModule.read());
      expect(latestConfig.owner).to.equal(newOwner);

      // No op if the same owner
      const txs = await evmERC20WarpModule.update({
        ...config,
        owner: newOwner,
      });
      expect(txs.length).to.equal(0);
    });

    it('should update the ProxyAdmin owner only if they are different', async () => {
      const config: TokenRouterConfig = {
        ...baseConfig,
        type: TokenType.native,
        hook: hookAddress,
        ismFactoryAddresses,
      };

      const owner = signer.address.toLowerCase();
      const evmERC20WarpModule = await EvmERC20WarpModule.create({
        chain,
        config: {
          ...config,
          interchainSecurityModule: ismAddress,
        },
        multiProvider,
      });

      const currentConfig = await evmERC20WarpModule.read();
      expect(currentConfig.proxyAdmin?.owner.toLowerCase()).to.equal(owner);

      const newOwner = randomAddress();
      const updatedWarpCoreConfig: TokenRouterConfig = {
        ...config,
        proxyAdmin: {
          address: currentConfig.proxyAdmin!.address,
          owner: newOwner,
        },
      };
      await sendTxs(await evmERC20WarpModule.update(updatedWarpCoreConfig));

      const latestConfig: TokenRouterConfig = normalizeConfig(
        await evmERC20WarpModule.read(),
      );
      expect(latestConfig.proxyAdmin?.owner).to.equal(newOwner);
      // Sanity check to be sure that the owner of the warp route token has not been updated if not changed
      expect(latestConfig.owner).to.equal(owner);

      // No op if the same owner
      const txs = await evmERC20WarpModule.update(updatedWarpCoreConfig);
      expect(txs.length).to.equal(0);
    });

    it('should update the destination gas', async () => {
      const domain = 3;
      const config: TokenRouterConfig = {
        ...baseConfig,
        type: TokenType.native,
        hook: hookAddress,
        ismFactoryAddresses,
        remoteRouters: {
          [domain]: randomAddress(),
        },
      };

      // Deploy using WarpModule
      const evmERC20WarpModule = await EvmERC20WarpModule.create({
        chain,
        config: {
          ...config,
        },
        multiProvider,
      });
      await sendTxs(
        await evmERC20WarpModule.update({
          ...config,
          destinationGas: {
            [domain]: '5000',
          },
        }),
      );

      const updatedConfig = await evmERC20WarpModule.read();
      expect(Object.keys(updatedConfig.destinationGas!).length).to.be.equal(1);
      expect(updatedConfig.destinationGas![domain]).to.equal('5000');
    });
  });
});
