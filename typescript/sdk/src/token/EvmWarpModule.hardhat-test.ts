import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { ethers } from 'ethers';
import hre from 'hardhat';
import sinon from 'sinon';
import { UINT_256_MAX } from 'starknet';

import {
  CONTRACTS_PACKAGE_VERSION,
  ERC20Test,
  ERC20Test__factory,
  ERC4626Test,
  ERC4626Test__factory,
  GasRouter,
  HypERC20__factory,
  HypERC4626Collateral__factory,
  HypNative__factory,
  Mailbox,
  MailboxClient__factory,
  Mailbox__factory,
  MockEverclearAdapter,
  MockEverclearAdapter__factory,
  MovableCollateralRouter__factory,
} from '@hyperlane-xyz/core';
import {
  EvmIsmModule,
  HookConfig,
  HookType,
  HyperlaneAddresses,
  HyperlaneContractsMap,
  IsmConfig,
  IsmType,
  RouterConfig,
  TestChainName,
  TokenFeeType,
  proxyAdmin,
  proxyImplementation,
  serializeContracts,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  addressToBytes32,
  assert,
  deepCopy,
  eqAddress,
  normalizeAddressEvm,
  objMap,
  randomInt,
} from '@hyperlane-xyz/utils';

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

import { EvmWarpModule } from './EvmWarpModule.js';
import {
  EverclearTokenBridgeTokenType,
  MovableTokenType,
  TokenType,
  isMovableCollateralTokenType,
} from './config.js';
import {
  HypTokenRouterConfig,
  HypTokenRouterConfigSchema,
  derivedHookAddress,
  isEverclearTokenBridgeConfig,
  isMovableCollateralTokenConfig,
} from './types.js';

chai.use(chaiAsPromised);
const { expect } = chai;

const randomRemoteRouters = (n: number) => {
  const routers: RemoteRouters = {};
  for (let domain = 0; domain < n; domain++) {
    routers[domain] = {
      address: randomAddress(),
    };
  }
  return routers;
};

describe('EvmWarpModule', async () => {
  const TOKEN_NAME = 'fake';
  const TOKEN_SUPPLY = '100000000000000000000';
  const TOKEN_DECIMALS = 18;
  const chain = TestChainName.test4;
  const domainId = 31337;
  let mailbox: Mailbox;
  let ismAddress: string;
  let ismFactory: HyperlaneIsmFactory;
  let factories: HyperlaneContractsMap<ProxyFactoryFactories>;
  let ismFactoryAddresses: HyperlaneAddresses<ProxyFactoryFactories>;
  let erc20Factory: ERC20Test__factory;
  let vaultFactory: ERC4626Test__factory;
  let vault: ERC4626Test;
  let token: ERC20Test;
  let feeToken: ERC20Test;
  let everclearBridgeAdapterMockFactory: MockEverclearAdapter__factory;
  let everclearBridgeAdapterMock: MockEverclearAdapter;
  let signer: SignerWithAddress;
  let multiProvider: MultiProvider;
  let coreApp: TestCoreApp;
  let routerConfigMap: ChainMap<RouterConfig>;
  let baseConfig: RouterConfig;

  async function validateCoreValues(deployedToken: GasRouter) {
    expect(await deployedToken.mailbox()).to.equal(mailbox.address);
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

    feeToken = await erc20Factory.deploy(
      TOKEN_NAME,
      TOKEN_NAME,
      TOKEN_SUPPLY,
      TOKEN_DECIMALS,
    );
    vaultFactory = new ERC4626Test__factory(signer);
    vault = await vaultFactory.deploy(token.address, TOKEN_NAME, TOKEN_NAME);

    baseConfig = routerConfigMap[chain];

    mailbox = Mailbox__factory.connect(baseConfig.mailbox, signer);
    ismAddress = await mailbox.defaultIsm();

    everclearBridgeAdapterMockFactory = new MockEverclearAdapter__factory(
      signer,
    );
    everclearBridgeAdapterMock =
      await everclearBridgeAdapterMockFactory.deploy();
  });

  const movableCollateralTypes = Object.values(TokenType).filter(
    isMovableCollateralTokenType,
  ) as MovableTokenType[];

  const everclearTokenBridgeTypes = [
    TokenType.ethEverclear,
    TokenType.collateralEverclear,
  ] as EverclearTokenBridgeTokenType[];

  const assertAllowedRebalancers = async (
    evmERC20WarpModule: EvmWarpModule,
    expectedRebalancers: string[],
  ) => {
    const currentConfig = await evmERC20WarpModule.read();

    if (isMovableCollateralTokenConfig(currentConfig)) {
      const currentRebalancers = Array.from(
        currentConfig.allowedRebalancers ?? [],
      );

      expect(currentRebalancers.length).to.equal(expectedRebalancers.length);
      currentRebalancers.forEach(
        (rebalancer, idx) =>
          expect(eqAddress(rebalancer, expectedRebalancers[idx])).to.be.true,
      );
    }
  };

  const getMovableTokenConfig = (
    allowedRebalancers: Address[] = [],
  ): Record<MovableTokenType, HypTokenRouterConfig> => {
    return {
      [TokenType.collateral]: {
        ...baseConfig,
        type: TokenType.collateral,
        token: token.address,
        allowedRebalancers,
      },
      [TokenType.native]: {
        ...baseConfig,
        type: TokenType.native,
        allowedRebalancers,
      },
      [TokenType.nativeScaled]: {
        ...baseConfig,
        type: TokenType.nativeScaled,
        allowedRebalancers,
      },
    };
  };

  const getEverclearTokenBridgeTokenConfig = (): Record<
    EverclearTokenBridgeTokenType,
    Extract<HypTokenRouterConfig, { type: EverclearTokenBridgeTokenType }>
  > => {
    const chainId = multiProvider.getChainId(chain);

    const everclearFeeParams = {
      [chainId]: {
        deadline: Date.now(),
        fee: randomInt(1000),
        signature: '0x',
      },
    };

    // Need to "enroll" otherwise the fee won't be set
    const remoteRouters = {
      [chainId]: {
        address: randomAddress(),
      },
    };

    return {
      [TokenType.collateralEverclear]: {
        type: TokenType.collateralEverclear,
        token: token.address,
        ...baseConfig,
        everclearBridgeAddress: everclearBridgeAdapterMock.address,
        everclearFeeParams,
        outputAssets: {},
        remoteRouters,
      },
      [TokenType.ethEverclear]: {
        type: TokenType.ethEverclear,
        wethAddress: token.address,
        ...baseConfig,
        everclearBridgeAddress: everclearBridgeAdapterMock.address,
        everclearFeeParams,
        outputAssets: {},
        remoteRouters,
      },
    };
  };

  it('should create with a collateral config', async () => {
    const config: HypTokenRouterConfig = {
      ...baseConfig,
      type: TokenType.collateral,
      token: token.address,
    };

    // Deploy using WarpModule
    const evmERC20WarpModule = await EvmWarpModule.create({
      chain,
      config,
      multiProvider,
      proxyFactoryFactories: ismFactoryAddresses,
    });

    // Let's derive it's onchain token type
    const { deployedTokenRoute } = evmERC20WarpModule.serialize();
    const tokenType: TokenType =
      await evmERC20WarpModule.reader.deriveTokenType(deployedTokenRoute);
    expect(tokenType).to.equal(TokenType.collateral);
  });

  it('should create with a collateral vault config', async () => {
    const config: HypTokenRouterConfig = {
      type: TokenType.collateralVault,
      token: vault.address,
      ...baseConfig,
    };

    // Deploy using WarpModule
    const evmERC20WarpModule = await EvmWarpModule.create({
      chain,
      config,
      multiProvider,
      proxyFactoryFactories: ismFactoryAddresses,
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
    const config: HypTokenRouterConfig = {
      ...baseConfig,
      type: TokenType.synthetic,
      name: TOKEN_NAME,
      symbol: TOKEN_NAME,
      decimals: TOKEN_DECIMALS,
      initialSupply: TOKEN_SUPPLY,
    };

    // Deploy using WarpModule
    const evmERC20WarpModule = await EvmWarpModule.create({
      chain,
      config,
      multiProvider,
      proxyFactoryFactories: ismFactoryAddresses,
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
      ...baseConfig,
    } as HypTokenRouterConfig;

    // Deploy using WarpModule
    const evmERC20WarpModule = await EvmWarpModule.create({
      chain,
      config,
      multiProvider,
      proxyFactoryFactories: ismFactoryAddresses,
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
      remoteRouters: randomRemoteRouters(numOfRouters),
    } as HypTokenRouterConfig;

    // Deploy using WarpModule
    const evmERC20WarpModule = await EvmWarpModule.create({
      chain,
      config,
      multiProvider,
      proxyFactoryFactories: ismFactoryAddresses,
    });
    const { remoteRouters } = await evmERC20WarpModule.read();
    expect(Object.keys(remoteRouters!).length).to.equal(numOfRouters);
  });

  for (const tokenType of movableCollateralTypes) {
    it(`should deploy the token with rebalancers when the token is of type "${tokenType}"`, async () => {
      const rebalancers = new Set([randomAddress(), randomAddress()]);
      const expectedRebalancers = Array.from(rebalancers);
      const config = deepCopy(
        getMovableTokenConfig(expectedRebalancers)[tokenType],
      );

      const evmERC20WarpModule = await EvmWarpModule.create({
        chain,
        config,
        multiProvider,
        proxyFactoryFactories: ismFactoryAddresses,
      });

      await assertAllowedRebalancers(evmERC20WarpModule, expectedRebalancers);
    });
  }

  for (const tokenType of everclearTokenBridgeTypes) {
    it(`should create ${tokenType} token`, async () => {
      const config = getEverclearTokenBridgeTokenConfig()[tokenType];

      // Deploy using WarpModule
      const evmERC20WarpModule = await EvmWarpModule.create({
        chain,
        config,
        multiProvider,
        proxyFactoryFactories: ismFactoryAddresses,
      });

      const currentConfig = await evmERC20WarpModule.read();

      assert(
        isEverclearTokenBridgeConfig(currentConfig),
        `Expected token of type ${tokenType}`,
      );
      expect(currentConfig.everclearBridgeAddress).to.deep.equal(
        config.everclearBridgeAddress,
      );
      expect(currentConfig.everclearFeeParams).to.deep.equal(
        config.everclearFeeParams,
      );
    });

    it(`should deploy with multiple output assets and fee setting when the token is of type ${tokenType}`, async () => {
      const baseConfig = getEverclearTokenBridgeTokenConfig()[tokenType];

      const domainId1 = randomInt(100, 10);
      const domainId2 = randomInt(1000, 100);
      const updatedConfig: typeof baseConfig = {
        ...baseConfig,
        remoteRouters: {
          [domainId1]: {
            address: randomAddress(),
          },
          [domainId2]: {
            address: randomAddress(),
          },
        },
        everclearFeeParams: {
          [domainId1]: {
            signature: '0x10',
            deadline: Date.now(),
            fee: randomInt(100),
          },
          [domainId2]: {
            signature: '0x10',
            deadline: Date.now(),
            fee: randomInt(100),
          },
        },
        outputAssets: {
          [domainId1]: addressToBytes32(randomAddress()),
          [domainId2]: addressToBytes32(randomAddress()),
        },
      };

      // Deploy using WarpModule
      const evmERC20WarpModule = await EvmWarpModule.create({
        chain,
        config: updatedConfig,
        multiProvider,
        proxyFactoryFactories: ismFactoryAddresses,
      });

      const currentConfig = await evmERC20WarpModule.read();

      assert(
        isEverclearTokenBridgeConfig(currentConfig),
        `Expected token of type ${tokenType}`,
      );
      expect(currentConfig.everclearBridgeAddress).to.deep.equal(
        updatedConfig.everclearBridgeAddress,
      );
      expect(currentConfig.everclearFeeParams).to.deep.equal(
        updatedConfig.everclearFeeParams,
      );
      expect(currentConfig.outputAssets).to.deep.equal(
        updatedConfig.outputAssets,
      );
    });
  }

  describe(EvmWarpModule.prototype.update.name, async () => {
    const owner = randomAddress();
    const ismConfigToUpdate: IsmConfig[] = [
      {
        type: IsmType.TRUSTED_RELAYER,
        relayer: owner,
      },
      {
        type: IsmType.FALLBACK_ROUTING,
        owner: owner,
        domains: {},
      },
      {
        type: IsmType.PAUSABLE,
        owner: owner,
        paused: false,
      },
      ethers.constants.AddressZero,
    ];

    const hookConfigToUpdate: HookConfig[] = [
      {
        type: HookType.PROTOCOL_FEE,
        beneficiary: owner,
        owner: owner,
        maxProtocolFee: '1337',
        protocolFee: '1337',
      },
      {
        type: HookType.INTERCHAIN_GAS_PAYMASTER,
        owner: owner,
        beneficiary: owner,
        oracleKey: owner,
        overhead: {},
        oracleConfig: {},
      },
      {
        type: HookType.MERKLE_TREE,
      },
    ];

    for (const interchainSecurityModule of ismConfigToUpdate) {
      it(`should deploy and set a new Ism (${typeof interchainSecurityModule === 'string' ? interchainSecurityModule : interchainSecurityModule.type})`, async () => {
        const config = {
          ...baseConfig,
          type: TokenType.native,
          interchainSecurityModule: ismAddress,
        } as HypTokenRouterConfig;

        // Deploy using WarpModule
        const evmERC20WarpModule = await EvmWarpModule.create({
          chain,
          config,
          multiProvider,
          proxyFactoryFactories: ismFactoryAddresses,
        });
        const actualConfig = await evmERC20WarpModule.read();

        const expectedConfig: HypTokenRouterConfig = {
          ...actualConfig,
          interchainSecurityModule,
        };
        await sendTxs(await evmERC20WarpModule.update(expectedConfig));
        const updatedConfig = normalizeConfig(
          (await evmERC20WarpModule.read()).interchainSecurityModule,
        );

        expect(updatedConfig).to.deep.equal(interchainSecurityModule);
      });
    }

    it('should not deploy and set a new Ism if the config is the same', async () => {
      const config = {
        ...baseConfig,
        type: TokenType.native,
        interchainSecurityModule: ismAddress,
      } as HypTokenRouterConfig;

      // Deploy using WarpModule
      const evmERC20WarpModule = await EvmWarpModule.create({
        chain,
        config,
        multiProvider,
        proxyFactoryFactories: ismFactoryAddresses,
      });
      const actualConfig = await evmERC20WarpModule.read();

      const owner = randomAddress();
      const interchainSecurityModule: IsmConfig = {
        type: IsmType.PAUSABLE,
        owner,
        paused: false,
      };
      const expectedConfig: HypTokenRouterConfig = {
        ...actualConfig,
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

    it('should update and set a new Hook based on config', async () => {
      const config = {
        ...baseConfig,
        type: TokenType.native,
      } as HypTokenRouterConfig;

      // Deploy using WarpModule
      const evmERC20WarpModule = await EvmWarpModule.create({
        chain,
        config,
        multiProvider,
        proxyFactoryFactories: ismFactoryAddresses,
      });
      const actualConfig = await evmERC20WarpModule.read();

      for (const hook of hookConfigToUpdate) {
        const expectedConfig: HypTokenRouterConfig = {
          ...actualConfig,
          hook,
        };
        await sendTxs(await evmERC20WarpModule.update(expectedConfig));

        const updatedConfig = await evmERC20WarpModule.read();
        expect(normalizeConfig(updatedConfig.hook)).to.deep.equal(hook);
      }
    });

    it('should set new deployed hook mailbox to WarpConfig.owner', async () => {
      const config = {
        ...baseConfig,
        type: TokenType.native,
      } as HypTokenRouterConfig;

      // Deploy using WarpModule
      const evmERC20WarpModule = await EvmWarpModule.create({
        chain,
        config,
        multiProvider,
        proxyFactoryFactories: ismFactoryAddresses,
      });
      const actualConfig = await evmERC20WarpModule.read();
      const expectedConfig: HypTokenRouterConfig = {
        ...actualConfig,
        hook: hookConfigToUpdate.find(
          (c: any) => c.type === HookType.MERKLE_TREE,
        ),
      };
      await sendTxs(await evmERC20WarpModule.update(expectedConfig));

      const updatedConfig = await evmERC20WarpModule.read();

      const hook = MailboxClient__factory.connect(
        derivedHookAddress(updatedConfig),
        multiProvider.getProvider(chain),
      );
      expect(await hook.mailbox()).to.equal(expectedConfig.mailbox);
    });

    it("should set Proxied Hook's proxyAdmins to WarpConfig.proxyAdmin", async () => {
      const config = {
        ...baseConfig,
        type: TokenType.native,
      } as HypTokenRouterConfig;

      // Deploy using WarpModule
      const evmERC20WarpModule = await EvmWarpModule.create({
        chain,
        config,
        multiProvider,
        proxyFactoryFactories: ismFactoryAddresses,
      });
      const actualConfig = await evmERC20WarpModule.read();
      const expectedConfig: HypTokenRouterConfig = {
        ...actualConfig,
        hook: hookConfigToUpdate.find(
          (c: any) => c.type === HookType.INTERCHAIN_GAS_PAYMASTER,
        ),
      };
      await sendTxs(await evmERC20WarpModule.update(expectedConfig));

      const updatedConfig = await evmERC20WarpModule.read();

      expect(
        await proxyAdmin(
          multiProvider.getProvider(chain),
          derivedHookAddress(updatedConfig),
        ),
      ).to.equal(expectedConfig.proxyAdmin?.address);
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
        interchainSecurityModule: deployedIsm,
      } as HypTokenRouterConfig;

      const evmERC20WarpModule = await EvmWarpModule.create({
        chain,
        config,
        multiProvider,
        proxyFactoryFactories: ismFactoryAddresses,
      });
      const actualConfig = await evmERC20WarpModule.read();
      const expectedConfig: HypTokenRouterConfig = {
        ...actualConfig,
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

    it('should enroll connected routers', async () => {
      const config = {
        ...baseConfig,
        type: TokenType.native,
        ismFactoryAddresses,
      } as HypTokenRouterConfig;

      // Deploy using WarpModule
      const evmERC20WarpModule = await EvmWarpModule.create({
        chain,
        config: {
          ...config,
          interchainSecurityModule: ismAddress,
        },
        multiProvider,
        proxyFactoryFactories: ismFactoryAddresses,
      });
      const numOfRouters = randomInt(10, 0);
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

    it('should unenroll connected routers', async () => {
      const config = {
        ...baseConfig,
        type: TokenType.native,
        ismFactoryAddresses,
      } as HypTokenRouterConfig;

      // Deploy using WarpModule
      const evmERC20WarpModule = await EvmWarpModule.create({
        chain,
        config: {
          ...config,
          interchainSecurityModule: ismAddress,
        },
        multiProvider,
        proxyFactoryFactories: ismFactoryAddresses,
      });
      const numOfRouters = randomInt(10, 0);
      await sendTxs(
        await evmERC20WarpModule.update({
          ...config,
          remoteRouters: randomRemoteRouters(numOfRouters),
        }),
      );
      // Read config & delete remoteRouters
      const existingConfig = await evmERC20WarpModule.read();
      for (let i = 0; i < numOfRouters; i++) {
        delete existingConfig.remoteRouters?.[i.toString()];
        await sendTxs(await evmERC20WarpModule.update(existingConfig));

        const updatedConfig = await evmERC20WarpModule.read();
        expect(Object.keys(updatedConfig.remoteRouters!).length).to.be.equal(
          numOfRouters - (i + 1),
        );
      }
    });

    it('should replace an enrollment if they are new one different, if the config lengths are the same', async () => {
      const config = {
        ...baseConfig,
        type: TokenType.native,
        ismFactoryAddresses,
      } as HypTokenRouterConfig;

      // Deploy using WarpModule
      const evmERC20WarpModule = await EvmWarpModule.create({
        chain,
        config: {
          ...config,
          interchainSecurityModule: ismAddress,
        },
        multiProvider,
        proxyFactoryFactories: ismFactoryAddresses,
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
      const extendedRemoteRouter = {
        3: {
          address: randomAddress(),
        },
      };
      txs = await evmERC20WarpModule.update({
        ...config,
        remoteRouters: extendedRemoteRouter,
      });

      expect(txs.length).to.equal(2);
      await sendTxs(txs);

      updatedConfig = await evmERC20WarpModule.read();
      expect(Object.keys(updatedConfig.remoteRouters!).length).to.be.equal(1);
      expect(updatedConfig.remoteRouters?.['3'].address.toLowerCase()).to.be.eq(
        addressToBytes32(extendedRemoteRouter['3'].address),
      );
    });

    it('should update the owner only if they are different', async () => {
      const config = {
        ...baseConfig,
        type: TokenType.native,
        ismFactoryAddresses,
      } as HypTokenRouterConfig;

      const owner = signer.address.toLowerCase();
      const evmERC20WarpModule = await EvmWarpModule.create({
        chain,
        config: {
          ...config,
          interchainSecurityModule: ismAddress,
        },
        multiProvider,
        proxyFactoryFactories: ismFactoryAddresses,
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
      const config: HypTokenRouterConfig = {
        ...baseConfig,
        type: TokenType.native,
      };

      const owner = signer.address.toLowerCase();
      const evmERC20WarpModule = await EvmWarpModule.create({
        chain,
        config: {
          ...config,
          interchainSecurityModule: ismAddress,
        },
        multiProvider,
        proxyFactoryFactories: ismFactoryAddresses,
      });

      const currentConfig = await evmERC20WarpModule.read();
      expect(currentConfig.proxyAdmin?.owner.toLowerCase()).to.equal(owner);

      const newOwner = randomAddress();
      const updatedWarpCoreConfig: HypTokenRouterConfig = {
        ...config,
        proxyAdmin: {
          address: currentConfig.proxyAdmin!.address,
          owner: newOwner,
        },
      };
      await sendTxs(await evmERC20WarpModule.update(updatedWarpCoreConfig));

      const latestConfig: HypTokenRouterConfig = normalizeConfig(
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
      const config: HypTokenRouterConfig = {
        ...baseConfig,
        type: TokenType.native,
        remoteRouters: {
          [domain]: {
            address: randomAddress(),
          },
        },
      };

      // Deploy using WarpModule
      const evmERC20WarpModule = await EvmWarpModule.create({
        chain,
        config: {
          ...config,
        },
        multiProvider,
        proxyFactoryFactories: ismFactoryAddresses,
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

    for (const tokenType of movableCollateralTypes) {
      it(`should add a new rebalancer on the deployed token if it is of type "${tokenType}"`, async () => {
        const initialRebalancer = randomAddress();
        const config = deepCopy(
          getMovableTokenConfig([initialRebalancer])[tokenType],
        );
        const evmERC20WarpModule = await EvmWarpModule.create({
          chain,
          config,
          multiProvider,
          proxyFactoryFactories: ismFactoryAddresses,
        });

        const expectedRebalancers = [initialRebalancer, randomAddress()];
        const txs = await evmERC20WarpModule.update({
          ...config,
          allowedRebalancers: expectedRebalancers,
        });

        expect(txs.length).to.equal(1);
        await sendTxs(txs);

        await assertAllowedRebalancers(evmERC20WarpModule, expectedRebalancers);
      });

      it(`should remove a rebalancer on the deployed token if the token is of type "${tokenType}"`, async () => {
        const rebalancerToKeep = randomAddress();
        const expectedRebalancers = [rebalancerToKeep];

        const rebalancers = new Set([rebalancerToKeep, randomAddress()]);
        const config = deepCopy(
          getMovableTokenConfig(Array.from(rebalancers))[tokenType],
        );
        const evmERC20WarpModule = await EvmWarpModule.create({
          chain,
          config,
          multiProvider,
          proxyFactoryFactories: ismFactoryAddresses,
        });

        const txs = await evmERC20WarpModule.update({
          ...config,
          allowedRebalancers: expectedRebalancers,
        });

        expect(txs.length).to.equal(1);
        await sendTxs(txs);

        await assertAllowedRebalancers(evmERC20WarpModule, expectedRebalancers);
      });

      it(`should not generate rebalancer update transactions if the address is in a different casing when token is of type "${tokenType}"`, async () => {
        const rebalancerToKeep = randomAddress();
        const config = deepCopy(
          getMovableTokenConfig([rebalancerToKeep.toLowerCase()])[tokenType],
        );

        const evmERC20WarpModule = await EvmWarpModule.create({
          chain,
          config,
          multiProvider,
          proxyFactoryFactories: ismFactoryAddresses,
        });

        const txs = await evmERC20WarpModule.update({
          ...config,
          allowedRebalancers: [rebalancerToKeep],
        });

        expect(txs.length).to.equal(0);
      });

      it(`should add the specified addresses as rebalancing bridges for tokens of type "${tokenType}"`, async () => {
        const movableTokenConfigs = getMovableTokenConfig();

        const config: HypTokenRouterConfig = {
          ...movableTokenConfigs[tokenType],
          remoteRouters: {
            [domainId]: {
              address: randomAddress(),
            },
          },
        };

        const allowedBridgeToAdd = normalizeAddressEvm(randomAddress());
        const evmERC20WarpModule = await EvmWarpModule.create({
          chain,
          config,
          multiProvider,
          proxyFactoryFactories: ismFactoryAddresses,
        });

        const txs = await evmERC20WarpModule.update(
          HypTokenRouterConfigSchema.parse({
            ...config,
            allowedRebalancingBridges: {
              [domainId]: [
                {
                  bridge: allowedBridgeToAdd,
                  approvedTokens: [feeToken.address],
                },
              ],
            },
          }),
        );

        // 1 tx to allow the bridge and another to approve the token
        expect(txs.length).to.equal(2);
        await sendTxs(txs);

        const warpTokenInstance = MovableCollateralRouter__factory.connect(
          evmERC20WarpModule.serialize().deployedTokenRoute,
          signer,
        );
        const check =
          await warpTokenInstance.callStatic.allowedBridges(domainId);
        expect(check[0]).to.eql(allowedBridgeToAdd);

        const allowance = await feeToken.callStatic.allowance(
          evmERC20WarpModule.serialize().deployedTokenRoute,
          allowedBridgeToAdd,
        );
        expect(allowance.toBigInt() === UINT_256_MAX).to.be.true;
      });

      it(`should remove rebalancing bridges for tokens of type "${tokenType}"`, async () => {
        const allowedBridgeToAdd = normalizeAddressEvm(randomAddress());
        const config = HypTokenRouterConfigSchema.parse({
          ...getMovableTokenConfig()[tokenType],
          remoteRouters: {
            [domainId]: {
              address: randomAddress(),
            },
          },
          allowedRebalancingBridges: {
            [domainId]: [
              {
                bridge: allowedBridgeToAdd,
                approvedTokens: [feeToken.address],
              },
            ],
          },
        });

        const evmERC20WarpModule = await EvmWarpModule.create({
          chain,
          config,
          multiProvider,
          proxyFactoryFactories: ismFactoryAddresses,
        });

        const txs = await evmERC20WarpModule.update(
          HypTokenRouterConfigSchema.parse({
            ...config,
            allowedRebalancingBridges: {
              [domainId]: [],
            },
          }),
        );

        // 1 tx to remove the bridge
        expect(txs.length).to.equal(1);
        await sendTxs(txs);

        const warpTokenInstance = MovableCollateralRouter__factory.connect(
          evmERC20WarpModule.serialize().deployedTokenRoute,
          signer,
        );

        const allowedBridges =
          await warpTokenInstance.callStatic.allowedBridges(domainId);
        expect(allowedBridges).to.be.empty;
      });

      it(`should not generate update transactions for the allowed rebalancing bridges if the address is in a different casing when token is of type "${tokenType}"`, async () => {
        const movableTokenConfigs = getMovableTokenConfig();

        const allowedBridgeToAdd = normalizeAddressEvm(randomAddress());
        const config = HypTokenRouterConfigSchema.parse({
          ...movableTokenConfigs[tokenType],
          remoteRouters: {
            [domainId]: {
              address: randomAddress(),
            },
          },
          allowedRebalancingBridges: {
            [domainId]: [
              {
                bridge: allowedBridgeToAdd,
                approvedTokens: [feeToken.address],
              },
            ],
          },
        });

        const evmERC20WarpModule = await EvmWarpModule.create({
          chain,
          config,
          multiProvider,
          proxyFactoryFactories: ismFactoryAddresses,
        });

        const txs = await evmERC20WarpModule.update(
          HypTokenRouterConfigSchema.parse({
            ...config,
            allowedRebalancingBridges: {
              [domainId]: [
                {
                  bridge: allowedBridgeToAdd.toLowerCase(),
                  approvedTokens: [feeToken.address],
                },
              ],
            },
          }),
        );

        expect(txs.length).to.equal(0);
      });

      it(`should add and remove a bridge on the deployed token if it is of type "${tokenType}" and the router map uses chain names instead of domainIds`, async () => {
        const bridges = [randomAddress(), randomAddress()];
        const remoteRouter = randomAddress();

        const config = deepCopy(getMovableTokenConfig()[tokenType]);
        const evmERC20WarpModule = await EvmWarpModule.create({
          chain,
          config: {
            ...config,
            remoteRouters: {
              [domainId]: {
                address: remoteRouter,
              },
            },
          },
          multiProvider,
          proxyFactoryFactories: ismFactoryAddresses,
        });

        let testCase = 0;
        for (const bridge of bridges) {
          const expectedNumOfTxs = testCase === 0 ? 1 : 2;
          const txs = await evmERC20WarpModule.update({
            ...config,
            allowedRebalancingBridges: {
              [chain]: [{ bridge }],
            },
          });

          expect(txs.length).to.equal(expectedNumOfTxs);
          await sendTxs(txs);

          const currentConfig = await evmERC20WarpModule.read();
          assert(isMovableCollateralTokenConfig(currentConfig), '');

          const [bridgeConfig] = Object.values(
            currentConfig.allowedRebalancingBridges ?? {},
          );
          expect(bridgeConfig).to.exist;
          expect(bridgeConfig.length).to.eql(1);
          expect(eqAddress(bridgeConfig[0].bridge, bridge)).to.be.true;

          testCase++;
        }
      });
    }

    for (const tokenType of everclearTokenBridgeTypes) {
      it(`should add destination outputAssets if the token is of type ${tokenType}`, async () => {
        const config = getEverclearTokenBridgeTokenConfig()[tokenType];

        const evmERC20WarpModule = await EvmWarpModule.create({
          chain,
          config,
          multiProvider,
          proxyFactoryFactories: ismFactoryAddresses,
        });

        const remoteToken = randomAddress();
        const txs = await evmERC20WarpModule.update({
          ...config,
          outputAssets: {
            [domainId]: remoteToken,
          },
        });

        expect(txs.length).to.equal(1);
        await sendTxs(txs);

        const currentConfig = await evmERC20WarpModule.read();

        assert(
          isEverclearTokenBridgeConfig(currentConfig),
          `Expected token of type ${tokenType}`,
        );
        expect(currentConfig.outputAssets[domainId]).to.equal(
          addressToBytes32(remoteToken),
        );
      });

      it(`should overwrite a destination outputAssets if the token is of type ${tokenType} and a destination token already exists for the given destination`, async () => {
        const config = getEverclearTokenBridgeTokenConfig()[tokenType];

        const evmERC20WarpModule = await EvmWarpModule.create({
          chain,
          config: {
            ...config,
            outputAssets: {
              [domainId]: randomAddress(),
            },
          },
          multiProvider,
          proxyFactoryFactories: ismFactoryAddresses,
        });

        const expectedRemoteOuputToken = randomAddress();
        const txs = await evmERC20WarpModule.update({
          ...config,
          outputAssets: {
            [domainId]: expectedRemoteOuputToken,
          },
        });

        expect(txs.length).to.equal(1);
        await sendTxs(txs);

        const currentConfig = await evmERC20WarpModule.read();

        assert(
          isEverclearTokenBridgeConfig(currentConfig),
          `Expected token of type ${tokenType}`,
        );
        expect(currentConfig.outputAssets[domainId]).to.equal(
          addressToBytes32(expectedRemoteOuputToken),
        );
      });

      it(`should remove destination outputAssets if the token is of type ${tokenType} and a config is set`, async () => {
        const config = getEverclearTokenBridgeTokenConfig()[tokenType];

        const evmERC20WarpModule = await EvmWarpModule.create({
          chain,
          config: {
            ...config,
            outputAssets: {
              [domainId]: randomAddress(),
            },
          },
          multiProvider,
          proxyFactoryFactories: ismFactoryAddresses,
        });

        const txs = await evmERC20WarpModule.update({
          ...config,
          outputAssets: {},
        });

        expect(txs.length).to.equal(1);
        await sendTxs(txs);

        const currentConfig = await evmERC20WarpModule.read();

        assert(
          isEverclearTokenBridgeConfig(currentConfig),
          `Expected token of type ${tokenType}`,
        );
        expect(currentConfig.outputAssets).to.deep.equal({});
      });

      it(`should remove 1 outputAsset and leave the others if the token is of type ${tokenType}`, async () => {
        const config = getEverclearTokenBridgeTokenConfig()[tokenType];

        const numOfRouters = randomInt(10, 0);
        const remoteRoutersToKeep = randomRemoteRouters(numOfRouters);
        const initialRemoteRouters = {
          [domainId]: {
            address: randomAddress(),
          },
          ...remoteRoutersToKeep,
        };

        const outputAssetsToKeep = objMap(remoteRoutersToKeep, (_domainId, _) =>
          randomAddress(),
        );

        const expectedOutputAssets = objMap(
          outputAssetsToKeep,
          (_domainId, address) => addressToBytes32(address),
        );
        const initialOutputAddresses = {
          [domainId]: randomAddress(),
          ...outputAssetsToKeep,
        };
        const evmERC20WarpModule = await EvmWarpModule.create({
          chain,
          config: {
            ...config,
            remoteRouters: initialRemoteRouters,
            outputAssets: initialOutputAddresses,
          },
          multiProvider,
          proxyFactoryFactories: ismFactoryAddresses,
        });

        const txs = await evmERC20WarpModule.update({
          ...config,
          remoteRouters: initialRemoteRouters,
          outputAssets: outputAssetsToKeep,
        });

        expect(txs.length).to.equal(1);
        await sendTxs(txs);

        const currentConfig = await evmERC20WarpModule.read();

        assert(
          isEverclearTokenBridgeConfig(currentConfig),
          `Expected token of type ${tokenType}`,
        );
        expect(currentConfig.outputAssets).to.deep.equal(expectedOutputAssets);
      });

      it(`should update the fee params if the token is of type ${tokenType}`, async () => {
        const config = getEverclearTokenBridgeTokenConfig()[tokenType];

        const evmERC20WarpModule = await EvmWarpModule.create({
          chain,
          config,
          multiProvider,
          proxyFactoryFactories: ismFactoryAddresses,
        });

        const expectedEverclearFeeParams = {
          [domainId]: {
            deadline: Date.now(),
            fee: randomInt(100000000, 100),
            signature: '0x42',
          },
        };
        const txs = await evmERC20WarpModule.update({
          ...config,
          everclearFeeParams: expectedEverclearFeeParams,
        });

        expect(txs.length).to.equal(1);
        await sendTxs(txs);

        const currentConfig = await evmERC20WarpModule.read();

        assert(
          isEverclearTokenBridgeConfig(currentConfig),
          `Expected token of type ${tokenType}`,
        );
        expect(currentConfig.everclearFeeParams).to.deep.equal(
          expectedEverclearFeeParams,
        );
      });

      it(`should not generate any update transactions for the fee params if the config did not change and the token is of type ${tokenType}`, async () => {
        const config = getEverclearTokenBridgeTokenConfig()[tokenType];

        const expectedEverclearFeeParams = config.everclearFeeParams;

        const evmERC20WarpModule = await EvmWarpModule.create({
          chain,
          config,
          multiProvider,
          proxyFactoryFactories: ismFactoryAddresses,
        });

        const txs = await evmERC20WarpModule.update(config);

        expect(txs.length).to.equal(0);

        const currentConfig = await evmERC20WarpModule.read();
        assert(
          isEverclearTokenBridgeConfig(currentConfig),
          `Expected token of type ${tokenType}`,
        );
        expect(currentConfig.everclearFeeParams).to.deep.equal(
          expectedEverclearFeeParams,
        );
      });

      it(`should remove everclear fee params if the token is of type ${tokenType}`, async () => {
        const config = getEverclearTokenBridgeTokenConfig()[tokenType];

        const evmERC20WarpModule = await EvmWarpModule.create({
          chain,
          config,
          multiProvider,
          proxyFactoryFactories: ismFactoryAddresses,
        });

        // Remove the fee params for the enrolled domain
        const txs = await evmERC20WarpModule.update({
          ...config,
          everclearFeeParams: {},
        });

        expect(txs.length).to.equal(1);
        await sendTxs(txs);

        const currentConfig = await evmERC20WarpModule.read();

        assert(
          isEverclearTokenBridgeConfig(currentConfig),
          `Expected token of type ${tokenType}`,
        );
        expect(currentConfig.everclearFeeParams).to.deep.equal({});
      });

      it(`should remove 1 everclear fee param and leave the others if the token is of type ${tokenType}`, async () => {
        const config = getEverclearTokenBridgeTokenConfig()[tokenType];

        const numOfRouters = randomInt(10, 0);
        const remoteRoutersToKeep = randomRemoteRouters(numOfRouters);
        const initialRemoteRouters = {
          [domainId]: {
            address: randomAddress(),
          },
          ...remoteRoutersToKeep,
        };

        const feeParamsToKeep = objMap(remoteRoutersToKeep, (_domainId, _) => ({
          deadline: Date.now(),
          fee: randomInt(1000),
          signature: '0x',
        }));

        const initialFeeParams = {
          [domainId]: {
            deadline: Date.now(),
            fee: randomInt(1000),
            signature: '0x',
          },
          ...feeParamsToKeep,
        };

        const evmERC20WarpModule = await EvmWarpModule.create({
          chain,
          config: {
            ...config,
            remoteRouters: initialRemoteRouters,
            everclearFeeParams: initialFeeParams,
          },
          multiProvider,
          proxyFactoryFactories: ismFactoryAddresses,
        });

        const txs = await evmERC20WarpModule.update({
          ...config,
          remoteRouters: initialRemoteRouters,
          everclearFeeParams: feeParamsToKeep,
        });

        expect(txs.length).to.equal(1);
        await sendTxs(txs);

        const currentConfig = await evmERC20WarpModule.read();

        assert(
          isEverclearTokenBridgeConfig(currentConfig),
          `Expected token of type ${tokenType}`,
        );
        expect(currentConfig.everclearFeeParams).to.deep.equal(feeParamsToKeep);
      });

      it(`should remove all everclear fee params except for explicitly kept domains if the token is of type ${tokenType}`, async () => {
        const config = getEverclearTokenBridgeTokenConfig()[tokenType];

        const domainId1 = randomInt(100, 10);
        const domainId2 = randomInt(1000, 100);
        const domainId3 = randomInt(10000, 1000);

        const initialRemoteRouters = {
          [domainId1]: {
            address: randomAddress(),
          },
          [domainId2]: {
            address: randomAddress(),
          },
          [domainId3]: {
            address: randomAddress(),
          },
        };

        const initialFeeParams = {
          [domainId1]: {
            deadline: Date.now(),
            fee: randomInt(1000),
            signature: '0x10',
          },
          [domainId2]: {
            deadline: Date.now(),
            fee: randomInt(1000),
            signature: '0x20',
          },
          [domainId3]: {
            deadline: Date.now(),
            fee: randomInt(1000),
            signature: '0x30',
          },
        };

        const evmERC20WarpModule = await EvmWarpModule.create({
          chain,
          config: {
            ...config,
            remoteRouters: initialRemoteRouters,
            everclearFeeParams: initialFeeParams,
          },
          multiProvider,
          proxyFactoryFactories: ismFactoryAddresses,
        });

        // Keep only domainId2
        const expectedFeeParams = {
          [domainId2]: initialFeeParams[domainId2],
        };

        const txs = await evmERC20WarpModule.update({
          ...config,
          remoteRouters: initialRemoteRouters,
          everclearFeeParams: expectedFeeParams,
        });

        expect(txs.length).to.equal(2);
        await sendTxs(txs);

        const currentConfig = await evmERC20WarpModule.read();

        assert(
          isEverclearTokenBridgeConfig(currentConfig),
          `Expected token of type ${tokenType}`,
        );
        expect(currentConfig.everclearFeeParams).to.deep.equal(
          expectedFeeParams,
        );
      });
    }

    it('Should deploy and upgrade a new warp route', async () => {
      const domain = 3;
      const config: HypTokenRouterConfig = {
        ...baseConfig,
        type: TokenType.collateral,
        token: token.address,
        remoteRouters: {
          [domain]: {
            address: randomAddress(),
          },
        },
      };

      // Deploy using WarpModule
      const evmERC20WarpModule = await EvmWarpModule.create({
        chain,
        config: {
          ...config,
        },
        multiProvider,
        proxyFactoryFactories: ismFactoryAddresses,
      });
      const { deployedTokenRoute } = evmERC20WarpModule.serialize();

      // Get original implementation address
      const origImpl = await proxyImplementation(
        multiProvider.getProvider(chain),
        deployedTokenRoute,
      );

      // I need package_VERSION to return an old version in the `read` call performed in update
      const versionStub = sinon
        .stub(evmERC20WarpModule.reader, 'fetchPackageVersion')
        .resolves('6.0.0');

      // In update, we do a check see if the package version is old
      // If it is, we deploy a new implementation and run upgradeTo
      await sendTxs(
        await evmERC20WarpModule.update({
          ...config,
          contractVersion: CONTRACTS_PACKAGE_VERSION,
        }),
      );

      versionStub.restore();
      const updatedConfig = await evmERC20WarpModule.read();

      // Assert
      expect(updatedConfig.contractVersion).to.eq(CONTRACTS_PACKAGE_VERSION);
      const newImpl = await proxyImplementation(
        multiProvider.getProvider(chain),
        deployedTokenRoute,
      );
      expect(origImpl).to.not.eq(newImpl);
    });

    it('Should not upgrade if the contract version is lower than the actual version', async () => {
      const domain = 3;
      const config: HypTokenRouterConfig = {
        ...baseConfig,
        type: TokenType.collateral,
        token: token.address,
        remoteRouters: {
          [domain]: {
            address: randomAddress(),
          },
        },
      };

      // Deploy using WarpModule
      const evmERC20WarpModule = await EvmWarpModule.create({
        chain,
        config: {
          ...config,
        },
        multiProvider,
        proxyFactoryFactories: ismFactoryAddresses,
      });

      // Return a really high version
      const reallyHighVersion = '10000.0.0';
      const versionStub = sinon
        .stub(evmERC20WarpModule.reader, 'fetchPackageVersion')
        .resolves(reallyHighVersion);

      // This will throw an error
      await expect(
        evmERC20WarpModule.update({
          ...config,
          contractVersion: CONTRACTS_PACKAGE_VERSION,
        }),
      ).to.be.rejectedWith(
        `Expected contract version ${CONTRACTS_PACKAGE_VERSION} is lower than actual contract version ${reallyHighVersion}`,
      );

      versionStub.restore();
      const updatedConfig = await evmERC20WarpModule.read();

      // Assert
      expect(updatedConfig.contractVersion).to.eq(CONTRACTS_PACKAGE_VERSION);
    });

    it('should deploy a new fee if one does not exist', async () => {
      const config: HypTokenRouterConfig = {
        ...baseConfig,
        type: TokenType.native,
      };

      // Deploy using WarpModule
      const evmERC20WarpModule = await EvmWarpModule.create({
        chain,
        config,
        multiProvider,
        proxyFactoryFactories: ismFactoryAddresses,
      });
      const actualConfig = await evmERC20WarpModule.read();

      const expectedConfig = HypTokenRouterConfigSchema.parse({
        ...actualConfig,
        tokenFee: {
          type: TokenFeeType.LinearFee,
          maxFee: 1000000000,
          halfAmount: 500000000,
        },
      });
      await sendTxs(await evmERC20WarpModule.update(expectedConfig));

      const updatedConfig = await evmERC20WarpModule.read();
      expect(updatedConfig.tokenFee?.type).to.equal(
        expectedConfig.tokenFee?.type,
      );
    });

    it('should not generate setFeeRecipient tx when fee recipient is unchanged (idempotency)', async () => {
      const config: HypTokenRouterConfig = {
        ...baseConfig,
        type: TokenType.native,
      };

      const evmERC20WarpModule = await EvmWarpModule.create({
        chain,
        config,
        multiProvider,
        proxyFactoryFactories: ismFactoryAddresses,
      });

      const tokenFeeConfig = {
        type: TokenFeeType.LinearFee,
        maxFee: 1000000000,
        halfAmount: 500000000,
      };

      const actualConfig = await evmERC20WarpModule.read();
      const expectedConfig = HypTokenRouterConfigSchema.parse({
        ...actualConfig,
        tokenFee: tokenFeeConfig,
      });

      const firstTxs = await evmERC20WarpModule.update(expectedConfig);
      const SET_FEE_RECIPIENT_SELECTOR = '0xe74b981b';
      const firstSetFeeRecipientTxs = firstTxs.filter((tx) =>
        tx.data?.startsWith(SET_FEE_RECIPIENT_SELECTOR),
      );
      expect(firstSetFeeRecipientTxs.length).to.equal(1);

      await sendTxs(firstTxs);

      const secondTxs = await evmERC20WarpModule.update(expectedConfig);
      const secondSetFeeRecipientTxs = secondTxs.filter((tx) =>
        tx.data?.startsWith(SET_FEE_RECIPIENT_SELECTOR),
      );
      expect(
        secondSetFeeRecipientTxs.length,
        'setFeeRecipient should not be called when fee recipient is unchanged',
      ).to.equal(0);
    });

    it('should generate setFeeRecipient tx when fee recipient changes', async () => {
      const config: HypTokenRouterConfig = {
        ...baseConfig,
        type: TokenType.native,
      };

      const evmERC20WarpModule = await EvmWarpModule.create({
        chain,
        config,
        multiProvider,
        proxyFactoryFactories: ismFactoryAddresses,
      });

      const actualConfig = await evmERC20WarpModule.read();
      const firstFeeConfig = HypTokenRouterConfigSchema.parse({
        ...actualConfig,
        tokenFee: {
          type: TokenFeeType.LinearFee,
          maxFee: 1000000000,
          halfAmount: 500000000,
        },
      });
      await sendTxs(await evmERC20WarpModule.update(firstFeeConfig));

      const updatedConfig = await evmERC20WarpModule.read();
      const secondFeeConfig = HypTokenRouterConfigSchema.parse({
        ...updatedConfig,
        tokenFee: {
          type: TokenFeeType.LinearFee,
          maxFee: 2000000000,
          halfAmount: 1000000000,
        },
      });

      const txs = await evmERC20WarpModule.update(secondFeeConfig);
      const SET_FEE_RECIPIENT_SELECTOR = '0xe74b981b';
      const setFeeRecipientTxs = txs.filter((tx) =>
        tx.data?.startsWith(SET_FEE_RECIPIENT_SELECTOR),
      );

      expect(
        setFeeRecipientTxs.length,
        'setFeeRecipient should be called when fee contract address changes',
      ).to.equal(1);
    });
  });
});
