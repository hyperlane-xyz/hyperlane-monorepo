import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { ethers } from 'ethers';
import hre from 'hardhat';
import sinon from 'sinon';

import {
  CONTRACTS_PACKAGE_VERSION,
  CrossCollateralRoutingFee__factory,
  CrossCollateralRouter__factory,
  DelayedFlowRouterHookIsm__factory,
  ERC20Test,
  ERC20Test__factory,
  ERC4626Test,
  ERC4626Test__factory,
  GasRouter,
  GasRouter__factory,
  HypERC20__factory,
  HypERC4626Collateral__factory,
  HypNative__factory,
  HypXERC20__factory,
  LinearFee__factory,
  Mailbox,
  MailboxClient__factory,
  Mailbox__factory,
  MockEverclearAdapter,
  MockEverclearAdapter__factory,
  MovableCollateralRouter__factory,
  StaticAggregationIsm__factory,
  TokenBridgeCctpV2__factory,
  TokenRouter__factory,
  XERC20Test,
  XERC20Test__factory,
} from '@hyperlane-xyz/core';
import {
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
  isZeroishAddress,
  normalizeAddressEvm,
  objMap,
  randomInt,
} from '@hyperlane-xyz/utils';

import { TestCoreApp } from '../core/TestCoreApp.js';
import { TestCoreDeployer } from '../core/TestCoreDeployer.js';
import { HyperlaneProxyFactoryDeployer } from '../deploy/HyperlaneProxyFactoryDeployer.js';
import { ProxyFactoryFactories } from '../deploy/contracts.js';
import { deriveDelayedFlowEnrollmentTargets } from '../deploy/warp.js';
import { DerivedHookConfig } from '../hook/types.js';
import { EvmIsmModule } from '../ism/EvmIsmModule.js';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { AnnotatedEV5Transaction } from '../providers/ProviderType.js';
import { RemoteRouters } from '../router/types.js';
import { randomAddress } from '../test/testUtils.js';
import { ChainMap } from '../types.js';
import { collectHybridIsmNodes, normalizeConfig } from '../utils/ism.js';

import { EvmTokenFeeModule } from '../fee/EvmTokenFeeModule.js';
import { DEFAULT_ROUTER_KEY } from '../fee/types.js';
import {
  EvmWarpModule,
  MAX_LEGACY_BRIDGE_APPROVAL_VERSION,
} from './EvmWarpModule.js';
import {
  EverclearTokenBridgeTokenType,
  MovableTokenType,
  TokenType,
  isMovableCollateralTokenType,
} from './config.js';
import {
  DerivedTokenRouterConfig,
  HypTokenRouterConfig,
  HypTokenRouterConfigSchema,
  WarpRouteDeployConfigMailboxRequired,
  derivedHookAddress,
  isEverclearTokenBridgeConfig,
  isMovableCollateralTokenConfig,
} from './types.js';

chai.use(chaiAsPromised);
const { expect } = chai;

const routerInstallIndex = (
  txs: AnnotatedEV5Transaction[],
  router: Address,
  fn: 'setHook' | 'setInterchainSecurityModule',
): number => {
  const sighash = MailboxClient__factory.createInterface().getSighash(fn);
  return txs.findIndex(
    (tx) =>
      !!tx.to &&
      eqAddress(tx.to, router) &&
      !!tx.data &&
      tx.data.startsWith(sighash),
  );
};

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
    (t) =>
      isMovableCollateralTokenType(t) &&
      // CrossCollateralRouter contract too large for hardhat; covered by forge tests
      t !== TokenType.crossCollateral,
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
      [TokenType.crossCollateral]: {
        ...baseConfig,
        type: TokenType.crossCollateral,
        token: token.address,
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

    // The batch is submitted sequentially with no rollback, so a failure
    // between the two installs is a state the route can be left in. Installing
    // the hook first leaves the previous ISM verifying inbound messages;
    // installing the ISM first can leave a hybrid hook/ISM gating delivery with
    // nothing driving its postDispatch, which strands every message dispatched
    // in that window.
    it('installs the hook before the ISM when both change', async () => {
      const evmERC20WarpModule = await EvmWarpModule.create({
        chain,
        config: {
          ...baseConfig,
          type: TokenType.native,
          interchainSecurityModule: ismAddress,
        },
        multiProvider,
        proxyFactoryFactories: ismFactoryAddresses,
      });
      const { deployedTokenRoute } = evmERC20WarpModule.serialize();

      const expectedConfig: HypTokenRouterConfig = {
        ...(await evmERC20WarpModule.read()),
        interchainSecurityModule: {
          type: IsmType.PAUSABLE,
          owner: signer.address,
          paused: false,
        },
        hook: { type: HookType.MERKLE_TREE },
      };

      const txs = await evmERC20WarpModule.update(expectedConfig);

      const hookIndex = routerInstallIndex(txs, deployedTokenRoute, 'setHook');
      const ismIndex = routerInstallIndex(
        txs,
        deployedTokenRoute,
        'setInterchainSecurityModule',
      );
      expect(hookIndex).to.be.greaterThan(-1);
      expect(ismIndex).to.be.greaterThan(-1);
      expect(hookIndex).to.be.lessThan(ismIndex);
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
        // Also remove corresponding destinationGas entry to stay consistent
        if (existingConfig.destinationGas) {
          delete existingConfig.destinationGas[i.toString()];
        }
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

    it('normalizes chain-name crossCollateralRouters keys for multicollateral enroll/unenroll txs', async () => {
      const destinationDomain = multiProvider.getDomainId(TestChainName.test2);
      const keepRouterAddress = '0x1111111111111111111111111111111111111111';
      const keepRouter = addressToBytes32(keepRouterAddress);
      const addRouterAddress = '0x2222222222222222222222222222222222222222';
      const addRouter = addressToBytes32(addRouterAddress);
      const removeRouterAddress = '0x3333333333333333333333333333333333333333';
      const removeRouter = addressToBytes32(removeRouterAddress);

      const module = new EvmWarpModule(multiProvider, {
        chain,
        config: {
          ...baseConfig,
          type: TokenType.crossCollateral,
          token: token.address,
        } as HypTokenRouterConfig,
        addresses: {
          deployedTokenRoute: randomAddress(),
        },
      } as ConstructorParameters<typeof EvmWarpModule>[1]);

      const actualConfig = {
        ...baseConfig,
        type: TokenType.crossCollateral,
        token: token.address,
        crossCollateralRouters: {
          [destinationDomain]: [keepRouter, removeRouter],
        },
      } as Parameters<
        EvmWarpModule['createEnrollCrossCollateralRoutersTxs']
      >[0];
      const expectedConfig = {
        ...baseConfig,
        type: TokenType.crossCollateral,
        token: token.address,
        crossCollateralRouters: {
          [TestChainName.test2]: [keepRouterAddress.toUpperCase(), addRouter],
        },
      } as HypTokenRouterConfig;

      const enrollTxs = module.createEnrollCrossCollateralRoutersTxs(
        actualConfig,
        expectedConfig,
      );
      expect(enrollTxs.length).to.equal(1);
      const [enrollDomains, enrollRouters] =
        CrossCollateralRouter__factory.createInterface().decodeFunctionData(
          'enrollCrossCollateralRouters',
          enrollTxs[0].data!,
        );
      expect(enrollDomains.map(Number)).to.deep.equal([destinationDomain]);
      expect(enrollRouters[0].toLowerCase()).to.equal(addRouter.toLowerCase());

      const unenrollTxs = module.createUnenrollCrossCollateralRoutersTxs(
        actualConfig,
        expectedConfig,
      );
      expect(unenrollTxs.length).to.equal(1);
      const [unenrollDomains, unenrollRouters] =
        CrossCollateralRouter__factory.createInterface().decodeFunctionData(
          'unenrollCrossCollateralRouters',
          unenrollTxs[0].data!,
        );
      expect(unenrollDomains.map(Number)).to.deep.equal([destinationDomain]);
      expect(unenrollRouters[0].toLowerCase()).to.equal(
        removeRouter.toLowerCase(),
      );
    });

    it('unenrolls all crossCollateralRouters when expected config omits crossCollateralRouters', async () => {
      const destinationDomain = multiProvider.getDomainId(TestChainName.test2);
      const routerOne = addressToBytes32(
        '0x3333333333333333333333333333333333333333',
      );
      const routerTwo = addressToBytes32(
        '0x4444444444444444444444444444444444444444',
      );

      const module = new EvmWarpModule(multiProvider, {
        chain,
        config: {
          ...baseConfig,
          type: TokenType.crossCollateral,
          token: token.address,
        } as HypTokenRouterConfig,
        addresses: {
          deployedTokenRoute: randomAddress(),
        },
      } as ConstructorParameters<typeof EvmWarpModule>[1]);

      const actualConfig = {
        ...baseConfig,
        type: TokenType.crossCollateral,
        token: token.address,
        crossCollateralRouters: {
          [destinationDomain]: [routerOne, routerTwo],
        },
      } as DerivedTokenRouterConfig;

      const expectedConfig = {
        ...baseConfig,
        type: TokenType.crossCollateral,
        token: token.address,
      } as HypTokenRouterConfig;

      const unenrollTxs = module.createUnenrollCrossCollateralRoutersTxs(
        actualConfig,
        expectedConfig,
      );
      expect(unenrollTxs.length).to.equal(1);
      const [unenrollDomains, unenrollRouters] =
        CrossCollateralRouter__factory.createInterface().decodeFunctionData(
          'unenrollCrossCollateralRouters',
          unenrollTxs[0].data!,
        );
      expect(unenrollDomains.map(Number)).to.deep.equal([
        destinationDomain,
        destinationDomain,
      ]);
      expect(
        unenrollRouters.map((router: string) => router.toLowerCase()).sort(),
      ).to.deep.equal(
        [routerOne.toLowerCase(), routerTwo.toLowerCase()].sort(),
      );
    });

    it('preserves canonical bytes32 rebalance targets and recipients', () => {
      const localDomain = multiProvider.getDomainId(chain);
      const target = addressToBytes32(
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      );
      const recipient = addressToBytes32(
        '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      );
      const module = new EvmWarpModule(multiProvider, {
        chain,
        config: {
          ...baseConfig,
          type: TokenType.crossCollateral,
          token: token.address,
        } satisfies HypTokenRouterConfig,
        addresses: {
          ...ismFactoryAddresses,
          deployedTokenRoute: randomAddress(),
        },
      });
      const actualConfig = {
        ...baseConfig,
        hook: ethers.constants.AddressZero,
        interchainSecurityModule: ethers.constants.AddressZero,
        type: TokenType.crossCollateral,
        token: token.address,
        tokenFee: undefined,
        rebalanceTargets: {},
        rebalanceRecipients: {},
      } satisfies DerivedTokenRouterConfig;
      const expectedConfig = {
        ...baseConfig,
        type: TokenType.crossCollateral,
        token: token.address,
        rebalanceTargets: { [localDomain]: [target] },
        rebalanceRecipients: { [localDomain]: recipient },
      } satisfies HypTokenRouterConfig;

      const [targetTx] = module.createAddRebalanceTargetsUpdateTxs(
        actualConfig,
        expectedConfig,
      );
      assert(targetTx.data, 'Expected rebalance target calldata');
      const [, decodedTarget] =
        CrossCollateralRouter__factory.createInterface().decodeFunctionData(
          'addRebalanceTarget(uint32,bytes32)',
          targetTx.data,
        );
      expect(decodedTarget.toLowerCase()).to.equal(target);

      const [recipientTx] = module.createSetRecipientsUpdateTxs(
        actualConfig,
        expectedConfig,
      );
      assert(recipientTx.data, 'Expected rebalance recipient calldata');
      const [, decodedRecipient] =
        CrossCollateralRouter__factory.createInterface().decodeFunctionData(
          'setRecipient(uint32,bytes32)',
          recipientTx.data,
        );
      expect(decodedRecipient.toLowerCase()).to.equal(recipient);
    });

    it('rejects rebalance domains that cannot be read back', () => {
      const localDomain = multiProvider.getDomainId(chain);
      const unknownDomain = localDomain + 1000;
      const module = new EvmWarpModule(multiProvider, {
        chain,
        config: {
          ...baseConfig,
          type: TokenType.crossCollateral,
          token: token.address,
        } satisfies HypTokenRouterConfig,
        addresses: {
          ...ismFactoryAddresses,
          deployedTokenRoute: randomAddress(),
        },
      });
      const actualConfig = {
        ...baseConfig,
        hook: ethers.constants.AddressZero,
        interchainSecurityModule: ethers.constants.AddressZero,
        type: TokenType.crossCollateral,
        token: token.address,
        tokenFee: undefined,
      } satisfies DerivedTokenRouterConfig;
      const expectedConfig = {
        ...baseConfig,
        type: TokenType.crossCollateral,
        token: token.address,
        rebalanceTargets: {
          [unknownDomain]: [addressToBytes32(randomAddress())],
        },
      } satisfies HypTokenRouterConfig;

      expect(() =>
        module.createAddRebalanceTargetsUpdateTxs(actualConfig, expectedConfig),
      ).to.throw(`Rebalance domain ${unknownDomain}`);
    });

    it('removes stale rebalance config when expected fields are omitted', () => {
      const localDomain = multiProvider.getDomainId(chain);
      const target = addressToBytes32(randomAddress());
      const recipient = addressToBytes32(randomAddress());
      const module = new EvmWarpModule(multiProvider, {
        chain,
        config: {
          ...baseConfig,
          type: TokenType.crossCollateral,
          token: token.address,
        } satisfies HypTokenRouterConfig,
        addresses: {
          ...ismFactoryAddresses,
          deployedTokenRoute: randomAddress(),
        },
      });
      const actualConfig = {
        ...baseConfig,
        hook: ethers.constants.AddressZero,
        interchainSecurityModule: ethers.constants.AddressZero,
        type: TokenType.crossCollateral,
        token: token.address,
        tokenFee: undefined,
        rebalanceTargets: { [localDomain]: [target] },
        rebalanceRecipients: { [localDomain]: recipient },
      } satisfies DerivedTokenRouterConfig;
      const expectedConfig = {
        ...baseConfig,
        type: TokenType.crossCollateral,
        token: token.address,
      } satisfies HypTokenRouterConfig;

      expect(
        module.createRemoveRebalanceTargetsTxs(actualConfig, expectedConfig),
      ).to.have.length(1);
      expect(
        module.createRemoveRecipientsTxs(actualConfig, expectedConfig),
      ).to.have.length(1);
    });

    it('includes MC crossCollateralRouters domains in destination gas txs', async () => {
      const destinationDomain = multiProvider.getDomainId(TestChainName.test2);
      const enrolledRouter = addressToBytes32(
        '0x4444444444444444444444444444444444444444',
      );

      const module = new EvmWarpModule(multiProvider, {
        chain,
        config: {
          ...baseConfig,
          type: TokenType.crossCollateral,
          token: token.address,
        } as HypTokenRouterConfig,
        addresses: {
          deployedTokenRoute: randomAddress(),
        },
      } as ConstructorParameters<typeof EvmWarpModule>[1]);

      const actualConfig = {
        ...baseConfig,
        type: TokenType.crossCollateral,
        token: token.address,
        destinationGas: {},
        crossCollateralRouters: {
          [destinationDomain]: [enrolledRouter],
        },
      } as DerivedTokenRouterConfig;

      // Config has destinationGas for test2, but no remoteRouters — only crossCollateralRouters
      const expectedConfig = {
        ...baseConfig,
        type: TokenType.crossCollateral,
        token: token.address,
        crossCollateralRouters: {
          [TestChainName.test2]: [enrolledRouter],
        },
        destinationGas: {
          [TestChainName.test2]: '200000',
        },
      } as HypTokenRouterConfig;

      const gasTxs = module.createSetDestinationGasUpdateTxs(
        actualConfig,
        expectedConfig,
      );

      // Should produce a tx (not throw) even without remoteRouters
      expect(gasTxs.length).to.equal(1);

      // Should use standard setDestinationGas (MC overrides _setDestinationGas)
      const gasRouterIface = GasRouter__factory.createInterface();
      const decoded = gasRouterIface.decodeFunctionData(
        'setDestinationGas((uint32,uint256)[])',
        gasTxs[0].data!,
      );
      expect(decoded[0].length).to.equal(1);
      expect(decoded[0][0].domain).to.equal(destinationDomain);
      expect(decoded[0][0].gas.toString()).to.equal('200000');
    });

    it('throws when destinationGas set but no remoteRouters or crossCollateralRouters', async () => {
      const module = new EvmWarpModule(multiProvider, {
        chain,
        config: {
          ...baseConfig,
          type: TokenType.collateral,
          token: token.address,
        } as HypTokenRouterConfig,
        addresses: {
          deployedTokenRoute: randomAddress(),
        },
      } as ConstructorParameters<typeof EvmWarpModule>[1]);

      const actualConfig = {
        ...baseConfig,
        type: TokenType.collateral,
        token: token.address,
        destinationGas: {},
      } as DerivedTokenRouterConfig;

      const expectedConfig = {
        ...baseConfig,
        type: TokenType.collateral,
        token: token.address,
        destinationGas: {
          [TestChainName.test2]: '200000',
        },
      } as HypTokenRouterConfig;

      expect(() =>
        module.createSetDestinationGasUpdateTxs(actualConfig, expectedConfig),
      ).to.throw(/remoteRouters and crossCollateralRouters are empty/);
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

    it('should reuse a configured ProxyAdmin timelock', async () => {
      const config: HypTokenRouterConfig = {
        ...baseConfig,
        type: TokenType.native,
      };
      const evmWarpModule = await EvmWarpModule.create({
        chain,
        config: {
          ...config,
          interchainSecurityModule: ismAddress,
        },
        multiProvider,
        proxyFactoryFactories: ismFactoryAddresses,
      });
      const timelockConfig = {
        delay: 259_200,
        roles: {
          proposer: signer.address,
          executor: signer.address,
        },
      };

      const firstUpdate = await evmWarpModule.updateSplit({
        ...config,
        timelock: timelockConfig,
      });
      expect(firstUpdate.ownershipTxs.length).to.equal(1);
      await sendTxs(firstUpdate.ownershipTxs);

      const secondUpdate = await evmWarpModule.updateSplit({
        ...config,
        timelock: timelockConfig,
      });
      expect(secondUpdate.txs).to.be.empty;
      expect(secondUpdate.feeTxs).to.be.empty;
      expect(secondUpdate.ownershipTxs).to.be.empty;
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

    it('should update the feeHook', async () => {
      const config: HypTokenRouterConfig = {
        ...baseConfig,
        type: TokenType.synthetic,
        name: TOKEN_NAME,
        symbol: TOKEN_NAME,
        decimals: TOKEN_DECIMALS,
      };

      const evmERC20WarpModule = await EvmWarpModule.create({
        chain,
        config,
        multiProvider,
        proxyFactoryFactories: ismFactoryAddresses,
      });

      // Verify no feeHook initially
      const initialConfig = await evmERC20WarpModule.read();
      expect(initialConfig.feeHook).to.be.undefined;

      // Set feeHook to a random address
      const feeHookAddress = randomAddress();
      const txs = await evmERC20WarpModule.update({
        ...config,
        feeHook: feeHookAddress,
      });
      expect(txs.length).to.equal(1);
      await sendTxs(txs);

      // Verify feeHook was set
      const updatedConfig = await evmERC20WarpModule.read();
      assert(updatedConfig.feeHook != null, 'feeHook should be set');
      expect(eqAddress(updatedConfig.feeHook, feeHookAddress)).to.be.true;
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

        // Spoof a new (post-legacy) impl so `approvedTokens` are ignored: the new
        // router grants allowances per rebalance, so only the addBridge tx is emitted.
        const versionStub = sinon
          .stub(evmERC20WarpModule.reader, 'fetchPackageVersion')
          .resolves('12.0.0');

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

        versionStub.restore();

        expect(txs.length).to.equal(1);
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
        expect(allowance.toBigInt()).to.equal(0n);
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

      // Only collateral routes back the router with an ERC20 that could carry a
      // legacy standing allowance; native routes never had approvals.
      if (tokenType === TokenType.collateral) {
        // Plants a legacy type(uint256).max standing allowance from the router to
        // `bridge`, mimicking the pre-upgrade on-chain state left by `_addBridge`
        // (collateral token) or the legacy approvedTokens grant path (any token).
        const plantLegacyAllowance = async (
          router: Address,
          bridge: Address,
          erc20: ERC20Test = token,
        ): Promise<void> => {
          await hre.network.provider.request({
            method: 'hardhat_impersonateAccount',
            params: [router],
          });
          await hre.network.provider.request({
            method: 'hardhat_setBalance',
            params: [router, '0xDE0B6B3A7640000'],
          });
          const routerSigner = hre.ethers.provider.getSigner(router);
          await erc20
            .connect(routerSigner)
            .approve(bridge, ethers.constants.MaxUint256);
          await hre.network.provider.request({
            method: 'hardhat_stopImpersonatingAccount',
            params: [router],
          });
        };

        it(`should revoke a legacy standing bridge allowance during an in-place upgrade for a route of type "${tokenType}"`, async () => {
          const allowedBridge = normalizeAddressEvm(randomAddress());
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
                  bridge: allowedBridge,
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

          const router = evmERC20WarpModule.serialize().deployedTokenRoute;

          await plantLegacyAllowance(router, allowedBridge);
          expect(
            (
              await token.callStatic.allowance(router, allowedBridge)
            ).toBigInt(),
          ).to.equal(ethers.constants.MaxUint256.toBigInt());

          // Spoof an old (pre-revoke-semantics) impl so update() generates an
          // upgrade tx and the revoke gate opens. fetchScale is stubbed because
          // old contracts (< 11.0.0) default scale to 1.
          const versionStub = sinon
            .stub(evmERC20WarpModule.reader, 'fetchPackageVersion')
            .resolves('11.3.0');
          const scaleStub = sinon
            .stub(evmERC20WarpModule.reader, 'fetchScale')
            .resolves(undefined);

          const txs = await evmERC20WarpModule.update({
            ...config,
            contractVersion: CONTRACTS_PACKAGE_VERSION,
          });
          await sendTxs(txs);

          versionStub.restore();
          scaleStub.restore();

          // The revoke runs against the new impl after the upgrade tx.
          expect(
            (
              await token.callStatic.allowance(router, allowedBridge)
            ).toBigInt(),
          ).to.equal(0n);
        });

        it(`should revoke a legacy approvedTokens allowance during an in-place upgrade for a route of type "${tokenType}"`, async () => {
          const allowedBridge = normalizeAddressEvm(randomAddress());
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
                  bridge: allowedBridge,
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

          const router = evmERC20WarpModule.serialize().deployedTokenRoute;

          // Plant legacy max allowances on BOTH the collateral token and the
          // approvedToken, mimicking the pre-upgrade grants for a remaining bridge.
          await plantLegacyAllowance(router, allowedBridge);
          await plantLegacyAllowance(router, allowedBridge, feeToken);

          // Spoof an old impl so update() generates an upgrade and the revoke gate opens.
          const versionStub = sinon
            .stub(evmERC20WarpModule.reader, 'fetchPackageVersion')
            .resolves('11.3.0');
          const scaleStub = sinon
            .stub(evmERC20WarpModule.reader, 'fetchScale')
            .resolves(undefined);

          const txs = await evmERC20WarpModule.update({
            ...config,
            contractVersion: CONTRACTS_PACKAGE_VERSION,
          });
          await sendTxs(txs);

          versionStub.restore();
          scaleStub.restore();

          // Both the collateral and the approvedToken allowance are cleared post-upgrade.
          expect(
            (
              await token.callStatic.allowance(router, allowedBridge)
            ).toBigInt(),
          ).to.equal(0n);
          expect(
            (
              await feeToken.callStatic.allowance(router, allowedBridge)
            ).toBigInt(),
          ).to.equal(0n);
        });

        it(`should not emit a revoke tx when no upgrade is generated for a route of type "${tokenType}"`, async () => {
          const allowedBridge = normalizeAddressEvm(randomAddress());
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
                  bridge: allowedBridge,
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

          const router = evmERC20WarpModule.serialize().deployedTokenRoute;

          // Plant a legacy allowance so a stray revoke would be visible.
          await plantLegacyAllowance(router, allowedBridge);

          // Keep the fixture on a legacy version. With no contractVersion bump,
          // update() generates no upgrade tx and the revoke gate stays closed.
          const versionStub = sinon
            .stub(evmERC20WarpModule.reader, 'fetchPackageVersion')
            .resolves(MAX_LEGACY_BRIDGE_APPROVAL_VERSION);

          const txs = await evmERC20WarpModule.update(config);
          await sendTxs(txs);

          versionStub.restore();

          // The legacy allowance is untouched (revoke must run only post-upgrade).
          expect(
            (
              await token.callStatic.allowance(router, allowedBridge)
            ).toBigInt(),
          ).to.equal(ethers.constants.MaxUint256.toBigInt());
        });

        it(`should revoke a stale allowance on an already-upgraded impl with no scheduled upgrade for a route of type "${tokenType}"`, async () => {
          const allowedBridge = normalizeAddressEvm(randomAddress());
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
                  bridge: allowedBridge,
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

          const router = evmERC20WarpModule.serialize().deployedTokenRoute;

          // A stale legacy allowance left by a prior run that upgraded the impl but
          // whose revoke txs never executed.
          await plantLegacyAllowance(router, allowedBridge);

          // Spoof the on-chain version above the legacy bound (already upgraded).
          const versionStub = sinon
            .stub(evmERC20WarpModule.reader, 'fetchPackageVersion')
            .resolves('12.0.0');
          const scaleStub = sinon
            .stub(evmERC20WarpModule.reader, 'fetchScale')
            .resolves(undefined);

          const actualConfig = await evmERC20WarpModule.read();

          versionStub.restore();
          scaleStub.restore();

          // No upgrade scheduled this run, but the stale allowance must still be
          // cleaned up — the revoke runs against the already-new impl. This keeps
          // cleanup retryable after a partially-executed upgrade.
          const revokeTxs =
            await evmERC20WarpModule.createRevokeStaleBridgeAllowancesTxs(
              actualConfig,
              config,
              false,
            );
          expect(revokeTxs.length).to.equal(1);
          await sendTxs(revokeTxs);

          expect(
            (
              await token.callStatic.allowance(router, allowedBridge)
            ).toBigInt(),
          ).to.equal(0n);
        });

        it(`should not emit a revoke tx on an already-upgraded impl with no stale allowance for a route of type "${tokenType}"`, async () => {
          const allowedBridge = normalizeAddressEvm(randomAddress());
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
                  bridge: allowedBridge,
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

          // No allowance is planted: a clean already-upgraded router has nothing
          // stale, so the non-zero allowance filter emits no revoke tx.
          const versionStub = sinon
            .stub(evmERC20WarpModule.reader, 'fetchPackageVersion')
            .resolves('12.0.0');
          const scaleStub = sinon
            .stub(evmERC20WarpModule.reader, 'fetchScale')
            .resolves(undefined);

          const actualConfig = await evmERC20WarpModule.read();

          versionStub.restore();
          scaleStub.restore();

          const revokeTxs =
            await evmERC20WarpModule.createRevokeStaleBridgeAllowancesTxs(
              actualConfig,
              config,
              false,
            );
          expect(revokeTxs).to.be.empty;
        });

        it(`should not emit a revoke tx for a removed bridge (handled on-chain by _removeBridge) for a route of type "${tokenType}"`, async () => {
          const removedBridge = normalizeAddressEvm(randomAddress());
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
                  bridge: removedBridge,
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

          const router = evmERC20WarpModule.serialize().deployedTokenRoute;

          // Give the bridge a legacy standing allowance so a stray revoke would be visible.
          await plantLegacyAllowance(router, removedBridge);

          // The bridge is dropped from the expected config: _removeBridge revokes it
          // on-chain, so this method must not emit a revoke tx for it (intersection
          // of actual and expected allowlisted bridges is empty).
          const expectedConfig = HypTokenRouterConfigSchema.parse({
            ...config,
            allowedRebalancingBridges: {
              [domainId]: [],
            },
          });

          const actualConfig = await evmERC20WarpModule.read();
          const revokeTxs =
            await evmERC20WarpModule.createRevokeStaleBridgeAllowancesTxs(
              actualConfig,
              expectedConfig,
              true,
            );
          expect(revokeTxs).to.be.empty;
        });

        it(`should not emit a revoke tx for a newly-added bridge for a route of type "${tokenType}"`, async () => {
          const config = HypTokenRouterConfigSchema.parse({
            ...getMovableTokenConfig()[tokenType],
            remoteRouters: {
              [domainId]: {
                address: randomAddress(),
              },
            },
            allowedRebalancingBridges: {
              [domainId]: [],
            },
          });

          const evmERC20WarpModule = await EvmWarpModule.create({
            chain,
            config,
            multiProvider,
            proxyFactoryFactories: ismFactoryAddresses,
          });

          // A bridge present in expected but not in actual is brand new; it never held
          // a legacy allowance, so no revoke tx should be emitted for it.
          const addedBridge = normalizeAddressEvm(randomAddress());
          const expectedConfig = HypTokenRouterConfigSchema.parse({
            ...config,
            allowedRebalancingBridges: {
              [domainId]: [
                {
                  bridge: addedBridge,
                },
              ],
            },
          });

          const actualConfig = await evmERC20WarpModule.read();
          const revokeTxs =
            await evmERC20WarpModule.createRevokeStaleBridgeAllowancesTxs(
              actualConfig,
              expectedConfig,
              true,
            );
          expect(revokeTxs).to.be.empty;
        });

        it(`should revoke a stale allowance for a bridge moved between domains for a route of type "${tokenType}"`, async () => {
          const movedBridge = normalizeAddressEvm(randomAddress());
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
                  bridge: movedBridge,
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

          const router = evmERC20WarpModule.serialize().deployedTokenRoute;

          // Legacy allowances on both the collateral and the approvedToken.
          await plantLegacyAllowance(router, movedBridge);
          await plantLegacyAllowance(router, movedBridge, feeToken);

          // Expected config keeps the same bridge but on a different domain. ERC20
          // allowances are (router, bridge) and domain-agnostic, so the stale
          // allowance must still be revoked despite the move.
          const otherChain = TestChainName.test2;
          const expectedConfig = HypTokenRouterConfigSchema.parse({
            ...config,
            remoteRouters: {
              [domainId]: {
                address: randomAddress(),
              },
              [otherChain]: {
                address: randomAddress(),
              },
            },
            allowedRebalancingBridges: {
              [otherChain]: [
                {
                  bridge: movedBridge,
                  approvedTokens: [feeToken.address],
                },
              ],
            },
          });

          const actualConfig = await evmERC20WarpModule.read();
          const revokeTxs =
            await evmERC20WarpModule.createRevokeStaleBridgeAllowancesTxs(
              actualConfig,
              expectedConfig,
              true,
            );

          const revokedTokens = revokeTxs.map((tx) => {
            assert(tx.data, 'expected revoke calldata');
            const [revokedToken] =
              MovableCollateralRouter__factory.createInterface().decodeFunctionData(
                'approveTokenForBridge(address,address)',
                tx.data,
              );
            return normalizeAddressEvm(revokedToken);
          });
          expect(revokedTokens).to.have.members([
            normalizeAddressEvm(token.address),
            normalizeAddressEvm(feeToken.address),
          ]);
        });

        it(`should emit an approval tx for approvedTokens on a legacy router for a route of type "${tokenType}"`, async () => {
          const allowedBridge = normalizeAddressEvm(randomAddress());
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
                  bridge: allowedBridge,
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

          // Spoof a legacy impl so `approveTokenForBridge` still grants max. The
          // emitted tx isn't executed here: the real (new-semantics) impl would
          // revoke instead of grant, so we assert on the SDK's intent — the grant
          // selector targeting the configured token and bridge.
          const versionStub = sinon
            .stub(evmERC20WarpModule.reader, 'fetchPackageVersion')
            .resolves('11.3.0');
          const scaleStub = sinon
            .stub(evmERC20WarpModule.reader, 'fetchScale')
            .resolves(undefined);

          const actualConfig = await evmERC20WarpModule.read();

          versionStub.restore();
          scaleStub.restore();

          const approvalTxs =
            await evmERC20WarpModule.getAllowedBridgesApprovalTxs(
              actualConfig,
              config,
            );

          expect(approvalTxs.length).to.equal(1);
          expect(approvalTxs[0].to).to.equal(
            evmERC20WarpModule.serialize().deployedTokenRoute,
          );

          assert(approvalTxs[0].data, 'expected approval calldata');
          const [token, bridge] =
            MovableCollateralRouter__factory.createInterface().decodeFunctionData(
              'approveTokenForBridge(address,address)',
              approvalTxs[0].data,
            );
          expect(eqAddress(token, feeToken.address)).to.be.true;
          expect(eqAddress(bridge, allowedBridge)).to.be.true;
        });
      }

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

        const expectedRemoteOutputToken = randomAddress();
        const txs = await evmERC20WarpModule.update({
          ...config,
          outputAssets: {
            [domainId]: expectedRemoteOutputToken,
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
          addressToBytes32(expectedRemoteOutputToken),
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

      // Also stub fetchScale to avoid version mismatch when reading scale
      // For old contracts (< 11.0.0), scale would default to 1
      const scaleStub = sinon
        .stub(evmERC20WarpModule.reader, 'fetchScale')
        .resolves(undefined);

      // In update, we do a check see if the package version is old
      // If it is, we deploy a new implementation and run upgradeTo
      await sendTxs(
        await evmERC20WarpModule.update({
          ...config,
          contractVersion: CONTRACTS_PACKAGE_VERSION,
        }),
      );

      versionStub.restore();
      scaleStub.restore();
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

    it('should deploy and update OffchainQuotedLinearFee via warp apply', async () => {
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
      const signerAddress = await multiProvider.getSignerAddress(chain);

      // Deploy with OffchainQuotedLinearFee
      const expectedConfig = HypTokenRouterConfigSchema.parse({
        ...actualConfig,
        tokenFee: {
          type: TokenFeeType.OffchainQuotedLinearFee,
          maxFee: 1000000000,
          halfAmount: 500000000,
          quoteSigners: [signerAddress],
        },
      });
      await sendTxs(await evmERC20WarpModule.update(expectedConfig));

      const updatedConfig = await evmERC20WarpModule.read();
      expect(updatedConfig.tokenFee?.type).to.equal(
        TokenFeeType.OffchainQuotedLinearFee,
      );

      // Update signers without redeploying
      const [, otherSigner] = await hre.ethers.getSigners();
      const updatedFeeConfig = HypTokenRouterConfigSchema.parse({
        ...updatedConfig,
        tokenFee: {
          type: TokenFeeType.OffchainQuotedLinearFee,
          maxFee: 1000000000,
          halfAmount: 500000000,
          quoteSigners: [signerAddress, otherSigner.address],
        },
      });
      const signerUpdateTxs = await evmERC20WarpModule.update(updatedFeeConfig);
      // 1 tx to add signer (no setFeeRecipient since address unchanged)
      expect(signerUpdateTxs.length).to.equal(1);
      await sendTxs(signerUpdateTxs);

      const finalConfig = await evmERC20WarpModule.read();
      expect(finalConfig.tokenFee?.type).to.equal(
        TokenFeeType.OffchainQuotedLinearFee,
      );
      if (finalConfig.tokenFee?.type === TokenFeeType.OffchainQuotedLinearFee) {
        expect(finalConfig.tokenFee.quoteSigners).to.have.lengthOf(2);
      }
    });

    describe('xERC20 token fee', () => {
      const SET_FEE_RECIPIENT_SELECTOR = '0xe74b981b';

      // The default test4 metadata configures an Etherscan explorer, which the
      // xERC20 reader would call to derive extra-lockbox configs on every
      // read(). Strip it on a scoped MultiProvider so lockbox derivation
      // early-returns []; XERC20Test has no extra lockboxes anyway.
      let xerc20MultiProvider: MultiProvider;
      before(() => {
        xerc20MultiProvider = MultiProvider.createTestMultiProvider({ signer });
        xerc20MultiProvider.metadata[chain] = {
          ...xerc20MultiProvider.getChainMetadata(chain),
          blockExplorers: [],
        };
      });

      // Deploys a fresh xERC20 warp route so each test starts with no fee.
      // XERC20Test grants unlimited mint/burn limits to any bridge, so no
      // limit-granting is required to exercise the fee-setting path.
      async function deployXERC20Route(): Promise<{
        warpModule: EvmWarpModule;
        xerc20: XERC20Test;
      }> {
        const xerc20 = await new XERC20Test__factory(signer).deploy(
          TOKEN_NAME,
          TOKEN_NAME,
          TOKEN_SUPPLY,
          TOKEN_DECIMALS,
        );
        const config: HypTokenRouterConfig = {
          ...baseConfig,
          type: TokenType.XERC20,
          token: xerc20.address,
        };
        const warpModule = await EvmWarpModule.create({
          chain,
          config,
          multiProvider: xerc20MultiProvider,
          proxyFactoryFactories: ismFactoryAddresses,
        });
        return { warpModule, xerc20 };
      }

      // LinearFee = min(maxFee, (amount * maxFee) / (2 * halfAmount)).
      function expectedLinearFee(
        maxFee: bigint,
        halfAmount: bigint,
        amount: bigint,
      ): bigint {
        const uncapped = (amount * maxFee) / (2n * halfAmount);
        return uncapped > maxFee ? maxFee : uncapped;
      }

      // Reads the deployed LinearFee contract wired to the router and asserts
      // its on-chain params. Critically verifies fee.token() == router.token(),
      // the exact invariant the router enforces at transfer time
      // ("FungibleTokenRouter: fee must match token").
      async function assertOnchainLinearFee(
        warpModule: EvmWarpModule,
        expected: { maxFee: bigint; halfAmount: bigint },
      ): Promise<void> {
        const { deployedTokenRoute } = warpModule.serialize();
        const router = HypXERC20__factory.connect(deployedTokenRoute, signer);
        const feeRecipient = await router.feeRecipient();
        expect(eqAddress(feeRecipient, ethers.constants.AddressZero)).to.be
          .false;

        const fee = LinearFee__factory.connect(feeRecipient, signer);
        expect(eqAddress(await fee.token(), await router.token())).to.be.true;
        expect((await fee.maxFee()).toBigInt()).to.equal(expected.maxFee);
        expect((await fee.halfAmount()).toBigInt()).to.equal(
          expected.halfAmount,
        );
      }

      it('charges the resolved token when quoting a fee-bearing transfer', async () => {
        const { warpModule } = await deployXERC20Route();
        const maxFee = 1_000_000_000n;
        const halfAmount = 500_000_000n;

        const actualConfig = await warpModule.read();
        const feeConfig = HypTokenRouterConfigSchema.parse({
          ...actualConfig,
          tokenFee: {
            type: TokenFeeType.LinearFee,
            maxFee: maxFee.toString(),
            halfAmount: halfAmount.toString(),
          },
        });
        await sendTxs(await warpModule.update(feeConfig));

        await assertOnchainLinearFee(warpModule, { maxFee, halfAmount });

        const { deployedTokenRoute } = warpModule.serialize();
        const router = HypXERC20__factory.connect(deployedTokenRoute, signer);
        const fee = LinearFee__factory.connect(
          await router.feeRecipient(),
          signer,
        );

        // Quote a transfer through the deployed fee contract: fee token must be
        // the router token and the amount must match the LinearFee formula.
        const amount = halfAmount; // fee = maxFee / 2
        const quotes = await fee.quoteTransferRemote(
          1,
          addressToBytes32(signer.address),
          amount,
        );
        expect(quotes.length).to.equal(1);
        expect(eqAddress(quotes[0].token, await router.token())).to.be.true;
        const expected = expectedLinearFee(maxFee, halfAmount, amount);
        expect(quotes[0].amount.toBigInt()).to.equal(expected);
        expect(expected > 0n, 'expected a non-zero fee').to.be.true;
      });

      it('should set a LinearFee on an xERC20 route via warp apply', async () => {
        const { warpModule } = await deployXERC20Route();

        const actualConfig = await warpModule.read();
        expect(actualConfig.tokenFee).to.be.undefined;

        const expectedConfig = HypTokenRouterConfigSchema.parse({
          ...actualConfig,
          tokenFee: {
            type: TokenFeeType.LinearFee,
            maxFee: 1000000000,
            halfAmount: 500000000,
          },
        });

        const txs = await warpModule.update(expectedConfig);
        const setFeeRecipientTxs = txs.filter((tx) =>
          tx.data?.startsWith(SET_FEE_RECIPIENT_SELECTOR),
        );
        expect(setFeeRecipientTxs.length).to.equal(1);
        await sendTxs(txs);

        const updatedConfig = await warpModule.read();
        expect(updatedConfig.tokenFee?.type).to.equal(TokenFeeType.LinearFee);
      });

      it('should update the fee on an xERC20 route', async () => {
        const { warpModule } = await deployXERC20Route();

        const actualConfig = await warpModule.read();
        const firstFeeConfig = HypTokenRouterConfigSchema.parse({
          ...actualConfig,
          tokenFee: {
            type: TokenFeeType.LinearFee,
            maxFee: 1000000000,
            halfAmount: 500000000,
          },
        });
        await sendTxs(await warpModule.update(firstFeeConfig));

        const afterFirst = await warpModule.read();
        assert(
          afterFirst.tokenFee?.type === TokenFeeType.LinearFee,
          'LinearFee',
        );

        const secondFeeConfig = HypTokenRouterConfigSchema.parse({
          ...afterFirst,
          tokenFee: {
            type: TokenFeeType.LinearFee,
            maxFee: 2000000000,
            halfAmount: 1000000000,
          },
        });

        const txs = await warpModule.update(secondFeeConfig);
        // Immutable fee contract is redeployed on change, so the router must be
        // repointed at the new fee contract via setFeeRecipient.
        const setFeeRecipientTxs = txs.filter((tx) =>
          tx.data?.startsWith(SET_FEE_RECIPIENT_SELECTOR),
        );
        expect(setFeeRecipientTxs.length).to.equal(1);
        await sendTxs(txs);

        const finalConfig = await warpModule.read();
        expect(finalConfig.tokenFee?.type).to.equal(TokenFeeType.LinearFee);
        // Assert the updated amounts and token are live on-chain, not just the
        // fee type. Confirms the new fee contract was wired with the new params.
        await assertOnchainLinearFee(warpModule, {
          maxFee: 2_000_000_000n,
          halfAmount: 1_000_000_000n,
        });
      });

      it('should set and update OffchainQuotedLinearFee on an xERC20 route', async () => {
        const { warpModule } = await deployXERC20Route();
        const signerAddress = await xerc20MultiProvider.getSignerAddress(chain);

        const actualConfig = await warpModule.read();
        const expectedConfig = HypTokenRouterConfigSchema.parse({
          ...actualConfig,
          tokenFee: {
            type: TokenFeeType.OffchainQuotedLinearFee,
            maxFee: 1000000000,
            halfAmount: 500000000,
            quoteSigners: [signerAddress],
          },
        });
        await sendTxs(await warpModule.update(expectedConfig));

        const updatedConfig = await warpModule.read();
        expect(updatedConfig.tokenFee?.type).to.equal(
          TokenFeeType.OffchainQuotedLinearFee,
        );

        const [, otherSigner] = await hre.ethers.getSigners();
        const updatedFeeConfig = HypTokenRouterConfigSchema.parse({
          ...updatedConfig,
          tokenFee: {
            type: TokenFeeType.OffchainQuotedLinearFee,
            maxFee: 1000000000,
            halfAmount: 500000000,
            quoteSigners: [signerAddress, otherSigner.address],
          },
        });
        const signerUpdateTxs = await warpModule.update(updatedFeeConfig);
        // Only add the new signer; fee contract address is unchanged so no
        // setFeeRecipient tx.
        expect(signerUpdateTxs.length).to.equal(1);
        await sendTxs(signerUpdateTxs);

        const finalConfig = await warpModule.read();
        assert(
          finalConfig.tokenFee?.type === TokenFeeType.OffchainQuotedLinearFee,
          'OffchainQuotedLinearFee',
        );
        expect(finalConfig.tokenFee.quoteSigners).to.have.lengthOf(2);
      });
    });

    it('clears orphan CCR fee pointer without explicit tokenReaderParams (CLI path)', async () => {
      // Simulates the production CLI path: EvmWarpModule.update() → createTokenFeeUpdateTxs()
      // called without explicit tokenReaderParams. The fix derives crossCollateralRouters hints
      // from actualConfig.crossCollateralRouters so orphan on-chain pointers are detected.

      // 1. Deploy a CCR fee contract and wire a stale router key to a sub-fee
      const ccrFactory = new CrossCollateralRoutingFee__factory(signer);
      const ccrf = await ccrFactory.deploy(signer.address);
      await ccrf.deployed();

      const linearFeeConfig = await EvmTokenFeeModule.expandConfig({
        multiProvider,
        chainName: chain,
        config: {
          type: TokenFeeType.LinearFee,
          token: token.address,
          owner: signer.address,
          bps: 100,
        },
      });
      const staleSubFeeModule = await EvmTokenFeeModule.create({
        multiProvider,
        chain,
        config: linearFeeConfig,
      });
      const staleSubFeeAddress = staleSubFeeModule.serialize().deployedFee;
      const routingDomain = multiProvider.getDomainId(chain);
      const staleRouterKey = hre.ethers.utils.hexZeroPad(signer.address, 32);

      await ccrf.setCrossCollateralRouterFeeContracts(
        [routingDomain],
        [staleRouterKey],
        [staleSubFeeAddress],
      );

      // 2. Build an EvmWarpModule with a fake token route address (not needed for this code path)
      const warpModule = new EvmWarpModule(multiProvider, {
        chain,
        config: {
          ...baseConfig,
          type: TokenType.crossCollateral,
          token: token.address,
        } as HypTokenRouterConfig,
        addresses: {
          deployedTokenRoute: randomAddress(),
          ...ismFactoryAddresses,
        },
      });

      // 3. actualConfig: CCR token with the stale router enrolled in crossCollateralRouters
      const actualConfig = {
        ...baseConfig,
        type: TokenType.crossCollateral,
        token: token.address,
        crossCollateralRouters: {
          [routingDomain]: [staleRouterKey],
        },
        tokenFee: {
          type: TokenFeeType.CrossCollateralRoutingFee,
          owner: signer.address,
          address: ccrf.address,
          feeContracts: {},
        },
      } as unknown as DerivedTokenRouterConfig;

      // 4. expectedConfig: CCR fee with only DEFAULT_ROUTER_KEY (stale key removed)
      const expectedConfig: HypTokenRouterConfig = {
        ...baseConfig,
        type: TokenType.crossCollateral,
        token: token.address,
        tokenFee: {
          type: TokenFeeType.CrossCollateralRoutingFee,
          owner: signer.address,
          feeContracts: {
            [chain]: {
              [DEFAULT_ROUTER_KEY]: {
                ...linearFeeConfig,
              },
            },
          },
        },
      };

      // 5. Call createTokenFeeUpdateTxs WITHOUT explicit tokenReaderParams
      const txs = await warpModule.createTokenFeeUpdateTxs(
        actualConfig,
        expectedConfig,
      );

      // Must include a clearing tx for the stale router key
      const clearTx = txs.find((tx) =>
        tx.annotation?.includes('Clearing removed CrossCollateralRoutingFee'),
      );
      expect(clearTx, 'expected orphan clearing tx').to.not.be.undefined;

      // Verify the tx encodes AddressZero for the stale key
      const iface = CrossCollateralRoutingFee__factory.createInterface();
      const decoded = iface.decodeFunctionData(
        'setCrossCollateralRouterFeeContracts',
        clearTx!.data!,
      );
      expect(decoded[1].map((k: string) => k.toLowerCase())).to.deep.equal([
        staleRouterKey.toLowerCase(),
      ]);
      expect(decoded[2]).to.deep.equal([hre.ethers.constants.AddressZero]);
    });
  });

  describe('createSetMaxFeePpmTxs', () => {
    const ROUTE_ADDRESS = '0x1111111111111111111111111111111111111111';
    const TOKEN_ADDRESS = '0x2222222222222222222222222222222222222222';
    const MESSENGER_ADDRESS = '0x3333333333333333333333333333333333333333';
    const TRANSMITTER_ADDRESS = '0x4444444444444444444444444444444444444444';

    let warpModule: EvmWarpModule;

    before(() => {
      warpModule = new EvmWarpModule(multiProvider, {
        chain,
        config: {} as HypTokenRouterConfig,
        addresses: {
          deployedTokenRoute: ROUTE_ADDRESS,
          ...ismFactoryAddresses,
        },
      });
    });

    const makeCctpV2Config = (
      maxFeeBps?: number,
      overrides?: Record<string, any>,
    ): HypTokenRouterConfig =>
      ({
        ...baseConfig,
        type: TokenType.collateralCctp,
        token: TOKEN_ADDRESS,
        tokenMessenger: MESSENGER_ADDRESS,
        messageTransmitter: TRANSMITTER_ADDRESS,
        cctpVersion: 'V2',
        urls: ['https://fake-cctp-url.com'],
        maxFeeBps,
        ...overrides,
      }) as HypTokenRouterConfig;

    it('returns empty when expectedConfig is not CCTP', () => {
      const actual = makeCctpV2Config(100) as DerivedTokenRouterConfig;
      const expected = {
        ...baseConfig,
        type: TokenType.collateral,
        token: TOKEN_ADDRESS,
      } as HypTokenRouterConfig;
      expect(warpModule.createSetMaxFeePpmTxs(actual, expected)).to.deep.equal(
        [],
      );
    });

    it('returns empty when cctpVersion is V1', () => {
      const actual = makeCctpV2Config(100) as DerivedTokenRouterConfig;
      const expected = makeCctpV2Config(200, { cctpVersion: 'V1' });
      expect(warpModule.createSetMaxFeePpmTxs(actual, expected)).to.deep.equal(
        [],
      );
    });

    it('returns empty when maxFeeBps is undefined', () => {
      const actual = makeCctpV2Config(100) as DerivedTokenRouterConfig;
      const expected = makeCctpV2Config(undefined);
      expect(warpModule.createSetMaxFeePpmTxs(actual, expected)).to.deep.equal(
        [],
      );
    });

    it('returns empty when actual matches expected', () => {
      const actual = makeCctpV2Config(1.3) as DerivedTokenRouterConfig;
      const expected = makeCctpV2Config(1.3);
      expect(warpModule.createSetMaxFeePpmTxs(actual, expected)).to.deep.equal(
        [],
      );
    });

    it('returns setMaxFeePpm tx when fee differs', () => {
      const actual = makeCctpV2Config(1) as DerivedTokenRouterConfig;
      const expected = makeCctpV2Config(1.3);
      const txs = warpModule.createSetMaxFeePpmTxs(actual, expected);

      expect(txs).to.have.length(1);
      expect(txs[0].to).to.equal(ROUTE_ADDRESS);
      expect(txs[0].data).to.equal(
        TokenBridgeCctpV2__factory.createInterface().encodeFunctionData(
          'setMaxFeePpm',
          [130],
        ),
      );
    });

    it('converts fractional bps to ppm correctly', () => {
      const actual = makeCctpV2Config(0) as DerivedTokenRouterConfig;
      const expected = makeCctpV2Config(1.5);
      const txs = warpModule.createSetMaxFeePpmTxs(actual, expected);

      expect(txs).to.have.length(1);
      expect(txs[0].data).to.equal(
        TokenBridgeCctpV2__factory.createInterface().encodeFunctionData(
          'setMaxFeePpm',
          [150],
        ),
      );
    });

    it('emits setMaxFeePpm when upgrading across PPM storage boundary even if values match', () => {
      const actual = makeCctpV2Config(1.3, {
        contractVersion: '10.1.0',
      }) as DerivedTokenRouterConfig;
      const expected = makeCctpV2Config(1.3, {
        contractVersion: '10.2.0',
      });
      const txs = warpModule.createSetMaxFeePpmTxs(actual, expected);

      expect(txs).to.have.length(1);
      expect(txs[0].data).to.equal(
        TokenBridgeCctpV2__factory.createInterface().encodeFunctionData(
          'setMaxFeePpm',
          [130],
        ),
      );
    });

    it('skips setMaxFeePpm when both versions are above PPM boundary and values match', () => {
      const actual = makeCctpV2Config(1.3, {
        contractVersion: '10.2.0',
      }) as DerivedTokenRouterConfig;
      const expected = makeCctpV2Config(1.3, {
        contractVersion: '10.3.0',
      });
      expect(warpModule.createSetMaxFeePpmTxs(actual, expected)).to.deep.equal(
        [],
      );
    });

    it('returns tx when actual has no maxFeeBps', () => {
      const actual = {
        ...baseConfig,
        type: TokenType.collateral,
        token: TOKEN_ADDRESS,
      } as DerivedTokenRouterConfig;
      const expected = makeCctpV2Config(2);
      const txs = warpModule.createSetMaxFeePpmTxs(actual, expected);

      expect(txs).to.have.length(1);
      expect(txs[0].data).to.equal(
        TokenBridgeCctpV2__factory.createInterface().encodeFunctionData(
          'setMaxFeePpm',
          [200],
        ),
      );
    });
  });

  describe('hybrid hook/ISM updates', () => {
    // Mirrors the shape `warp apply` produces: the hybrid must be composed
    // under an authenticating ISM, and expandWarpDeployConfig defaults the
    // expected hook to the hybrid node when the user leaves `hook` unset.
    function delayedFlowNode(owner: Address, maxDelay = 3600): IsmConfig {
      return {
        type: IsmType.DELAYED_FLOW_ROUTER,
        thresholdBps: 10000,
        maxDelay,
        duration: 86400n,
        owner,
      };
    }

    // Hook-side view of the same contract (same type string by design), which
    // is what expandWarpDeployConfig puts in the expected `hook` field.
    function delayedFlowHookNode(owner: Address, maxDelay = 3600): HookConfig {
      return {
        type: HookType.DELAYED_FLOW_ROUTER,
        thresholdBps: 10000,
        maxDelay,
        duration: 86400n,
        owner,
      };
    }

    // Hook-side view of the OTHER hybrid: same family, different contract.
    function netFlowHookNode(owner: Address): HookConfig {
      return {
        type: HookType.NET_FLOW_RATE_LIMITED,
        thresholdBps: 5000,
        duration: 86400n,
        owner,
      };
    }

    function delayedFlowIsm(owner: Address, maxDelay = 3600): IsmConfig {
      return {
        type: IsmType.AGGREGATION,
        threshold: 2,
        modules: [
          { type: IsmType.TRUSTED_RELAYER, relayer: owner },
          delayedFlowNode(owner, maxDelay),
        ],
      };
    }

    // ISM-side view of the OTHER hybrid, with the same parameters as
    // netFlowHookNode so the pair describes one instance.
    function netFlowIsm(owner: Address): IsmConfig {
      return {
        type: IsmType.AGGREGATION,
        threshold: 2,
        modules: [
          { type: IsmType.TRUSTED_RELAYER, relayer: owner },
          {
            type: IsmType.NET_FLOW_RATE_LIMITED,
            thresholdBps: 5000,
            duration: 86400n,
            owner,
          },
        ],
      };
    }

    // A route that exists without any hybrid: the starting point for
    // "user adds a DFR to an existing route".
    async function createPlainRoute() {
      return EvmWarpModule.create({
        chain,
        config: {
          ...baseConfig,
          type: TokenType.collateral,
          token: token.address,
          interchainSecurityModule: ismAddress,
        },
        multiProvider,
        proxyFactoryFactories: ismFactoryAddresses,
      });
    }

    it('adds a hybrid hook/ISM to an existing route, wiring it as ISM and hook', async () => {
      const warpModule = await createPlainRoute();
      const { deployedTokenRoute } = warpModule.serialize();

      const expectedConfig: HypTokenRouterConfig = {
        ...(await warpModule.read()),
        interchainSecurityModule: delayedFlowIsm(signer.address),
        hook: delayedFlowHookNode(signer.address),
      };

      const txs = await warpModule.update(expectedConfig);
      await sendTxs(txs);

      const client = MailboxClient__factory.connect(
        deployedTokenRoute,
        multiProvider.getProvider(chain),
      );
      const installedIsm = await client.interchainSecurityModule();
      const installedHook = await client.hook();
      expect(isZeroishAddress(installedHook)).to.be.false;

      // the hook is the DFR paired with this router...
      const dfr = DelayedFlowRouterHookIsm__factory.connect(
        installedHook,
        multiProvider.getProvider(chain),
      );
      expect(eqAddress(await dfr.warpRouter(), deployedTokenRoute)).to.be.true;
      expect(await dfr.maxDelay()).to.equal(3600);

      // ...and the same instance is a member of the installed aggregation ISM
      const aggregation = StaticAggregationIsm__factory.connect(
        installedIsm,
        multiProvider.getProvider(chain),
      );
      const [modules] = await aggregation.modulesAndThreshold(
        ethers.constants.AddressZero,
      );
      expect(modules.map((m) => m.toLowerCase())).to.include(
        installedHook.toLowerCase(),
      );
    });

    // A DFR installed as the ISM before it is the hook refuses every inbound
    // message (`readyAt == 0`) while nothing sends the preverification, and no
    // later run can preverify an already-dispatched message: the reverse order
    // only leaves the previous ISM in charge for the rest of the batch.
    it('wires the hybrid as the hook before installing it as the ISM', async () => {
      const warpModule = await createPlainRoute();
      const { deployedTokenRoute } = warpModule.serialize();

      const expectedConfig: HypTokenRouterConfig = {
        ...(await warpModule.read()),
        interchainSecurityModule: delayedFlowIsm(signer.address),
        hook: delayedFlowHookNode(signer.address),
      };

      const txs = await warpModule.update(expectedConfig);

      const hookIndex = routerInstallIndex(txs, deployedTokenRoute, 'setHook');
      const ismIndex = routerInstallIndex(
        txs,
        deployedTokenRoute,
        'setInterchainSecurityModule',
      );
      expect(hookIndex).to.be.greaterThan(-1);
      expect(ismIndex).to.be.greaterThan(-1);
      expect(hookIndex).to.be.lessThan(ismIndex);
    });

    it('removes the hybrid ISM before removing its hook', async () => {
      const warpModule = await createPlainRoute();
      const { deployedTokenRoute } = warpModule.serialize();
      const hybridConfig: HypTokenRouterConfig = {
        ...(await warpModule.read()),
        interchainSecurityModule: delayedFlowIsm(signer.address),
        hook: delayedFlowHookNode(signer.address),
      };
      await sendTxs(await warpModule.update(hybridConfig));

      const client = MailboxClient__factory.connect(
        deployedTokenRoute,
        multiProvider.getProvider(chain),
      );
      const installedHook = await client.hook();
      const removalConfig: HypTokenRouterConfig = {
        ...(await warpModule.read()),
        interchainSecurityModule: ethers.constants.AddressZero,
        hook: ethers.constants.AddressZero,
      };
      const txs = await warpModule.update(removalConfig);

      const hookIndex = routerInstallIndex(txs, deployedTokenRoute, 'setHook');
      const ismIndex = routerInstallIndex(
        txs,
        deployedTokenRoute,
        'setInterchainSecurityModule',
      );
      expect(ismIndex).to.be.greaterThan(-1);
      expect(hookIndex).to.be.greaterThan(-1);
      expect(ismIndex).to.be.lessThan(hookIndex);

      // If submission stops at this boundary, inbound verification is already
      // back on the mailbox default while origins may harmlessly send an extra
      // preverification until their hook-removal phase executes.
      await sendTxs(txs.slice(0, hookIndex));
      expect(await client.interchainSecurityModule()).to.equal(
        ethers.constants.AddressZero,
      );
      expect(await client.hook()).to.equal(installedHook);

      await sendTxs(txs.slice(hookIndex));
      expect(await client.hook()).to.equal(ethers.constants.AddressZero);
    });

    it('rejects a hybrid config that also sets a predicateWrapper', async () => {
      const warpModule = await createPlainRoute();
      const actualConfig = await warpModule.read();
      assert(
        actualConfig.type === TokenType.collateral,
        'Expected a collateral warp router config',
      );

      const expectedConfig: HypTokenRouterConfig = {
        ...actualConfig,
        interchainSecurityModule: delayedFlowIsm(signer.address),
        hook: delayedFlowHookNode(signer.address),
        predicateWrapper: {
          predicateRegistry: randomAddress(),
          policyId: 'test-policy',
          owner: signer.address,
        },
      };

      // Both want the router's hook slot; silently dropping either would
      // remove a policy hook or the flow limiter from the dispatch path.
      await expect(warpModule.update(expectedConfig)).to.be.rejectedWith(
        'both must own',
      );
    });

    it('rejects a hybrid added to a router type it cannot meter', async () => {
      const warpModule = await createPlainRoute();

      // collateralVault is not an LpCollateralRouter, so localCollateral()
      // reverts: the DFR would deploy fine and then brick every dispatch and
      // delivery. The deploy path rejects this; apply must too.
      const expectedConfig: HypTokenRouterConfig = {
        ...(await warpModule.read()),
        type: TokenType.collateralVault,
        token: token.address,
        interchainSecurityModule: delayedFlowIsm(signer.address),
        hook: delayedFlowHookNode(signer.address),
      };

      await expect(warpModule.update(expectedConfig)).to.be.rejectedWith(
        'cannot meter',
      );
    });

    it('rejects an unsupported hybrid config without deploying the ISM', async () => {
      const warpModule = await createPlainRoute();
      // The config-only guards used to run after the ISM step, so a rejected
      // apply had already paid for (and orphaned) a fresh hybrid instance.
      const deploySpy = sinon.spy(warpModule, 'deployOrUpdateIsm');

      const expectedConfig: HypTokenRouterConfig = {
        ...(await warpModule.read()),
        type: TokenType.collateralVault,
        token: token.address,
        interchainSecurityModule: delayedFlowIsm(signer.address),
        hook: delayedFlowHookNode(signer.address),
      };

      try {
        await expect(warpModule.update(expectedConfig)).to.be.rejectedWith(
          'cannot meter',
        );
        expect(deploySpy.called).to.be.false;
      } finally {
        deploySpy.restore();
      }
    });

    it('rejects a hybrid ISM tree pointed at a different hook', async () => {
      const warpModule = await createPlainRoute();

      // A read -> edit -> apply round trip that keeps an explicit non-hybrid
      // hook (e.g. an IGP) while adding a DFR to the ISM tree. Without a
      // guard the ISM deploys and is installed, but the hybrid never becomes
      // the router's hook, so it can never preverify: every delivery from
      // this chain would revert forever while `warp check` still converges.
      const nonHybridHook = await mailbox.defaultHook();
      const expectedConfig: HypTokenRouterConfig = {
        ...(await warpModule.read()),
        interchainSecurityModule: delayedFlowIsm(signer.address),
        hook: nonHybridHook,
      };

      await expect(warpModule.update(expectedConfig)).to.be.rejectedWith(
        "not in the 'hook' tree",
      );
    });

    it('rejects a hook node of a different hybrid type than the ISM tree installs', async () => {
      const warpModule = await createPlainRoute();

      // The ISM tree installs a DELAYED_FLOW instance while `hook` declares a
      // NET_FLOW one. Only the tree's own instance is ever wired, so the
      // declared hook would be silently ignored and the route would stay
      // permanently divergent from the config the operator wrote.
      const expectedConfig: HypTokenRouterConfig = {
        ...(await warpModule.read()),
        interchainSecurityModule: delayedFlowIsm(signer.address),
        hook: netFlowHookNode(signer.address),
      };

      await expect(warpModule.update(expectedConfig)).to.be.rejectedWith(
        'is declared differently on the two surfaces',
      );
    });

    it('ignores derived address metadata when hybrid declarations match', async () => {
      const warpModule = await createPlainRoute();

      // `address` is reader output, not declarative identity. Ignoring stale
      // metadata lets read -> edit -> apply replace a hybrid whose parameters
      // changed while the two config surfaces still describe the same target.
      const foreignInstanceHook: DerivedHookConfig = {
        type: HookType.DELAYED_FLOW_ROUTER,
        thresholdBps: 10000,
        maxDelay: 3600,
        duration: 86400n,
        owner: signer.address,
        address: randomAddress(),
      };
      const expectedConfig: HypTokenRouterConfig = {
        ...(await warpModule.read()),
        interchainSecurityModule: delayedFlowIsm(signer.address),
        hook: foreignInstanceHook,
      };

      await expect(warpModule.update(expectedConfig)).to.be.fulfilled;
    });

    it('explains a router whose ISM tree has no hybrid instance during enrollment', async () => {
      const warpModule = await createPlainRoute();
      const { deployedTokenRoute } = warpModule.serialize();

      // No hybrid was ever wired, so the enrollment pass cannot resolve a
      // DelayedFlowRouterHookIsm from the router's ISM tree.
      const deployConfig: WarpRouteDeployConfigMailboxRequired = {
        [chain]: {
          ...baseConfig,
          type: TokenType.collateral,
          token: token.address,
          interchainSecurityModule: delayedFlowIsm(signer.address),
        },
      };

      await expect(
        deriveDelayedFlowEnrollmentTargets(multiProvider, deployConfig, {
          [chain]: deployedTokenRoute,
        }),
      ).to.be.rejectedWith('no instance was resolved');
    });

    it('rejects a NetFlowRateLimitedHookIsm as a delayed-flow enrollment target', async () => {
      const warpModule = await createPlainRoute();
      const { deployedTokenRoute } = warpModule.serialize();

      // Wire the OTHER hybrid as the router's hook and ISM.
      await sendTxs(
        await warpModule.update({
          ...(await warpModule.read()),
          interchainSecurityModule: netFlowIsm(signer.address),
          hook: netFlowHookNode(signer.address),
        }),
      );

      // Both hybrids expose warpRouter() and both are paired with this router,
      // so a warpRouter()-only probe returns the NetFlow instance as a
      // DELAYED_FLOW_ROUTER enrollment target and pairs the wrong contract.
      const deployConfig: WarpRouteDeployConfigMailboxRequired = {
        [chain]: {
          ...baseConfig,
          type: TokenType.collateral,
          token: token.address,
          interchainSecurityModule: delayedFlowIsm(signer.address),
        },
      };

      await expect(
        deriveDelayedFlowEnrollmentTargets(multiProvider, deployConfig, {
          [chain]: deployedTokenRoute,
        }),
      ).to.be.rejectedWith('does not expose maxDelay()');
    });

    it('converges to zero transactions once the hybrid is wired', async () => {
      const warpModule = await createPlainRoute();

      const expectedConfig: HypTokenRouterConfig = {
        ...(await warpModule.read()),
        interchainSecurityModule: delayedFlowIsm(signer.address),
        hook: delayedFlowHookNode(signer.address),
      };

      await sendTxs(await warpModule.update(expectedConfig));

      // second apply of the same config must be a no-op
      expect(await warpModule.update(expectedConfig)).to.deep.equal([]);
    });

    it('round-trips a delayed-flow hybrid nested in an aggregation hook', async () => {
      const warpModule = await createPlainRoute();
      const expectedConfig: HypTokenRouterConfig = {
        ...(await warpModule.read()),
        interchainSecurityModule: delayedFlowIsm(signer.address),
        hook: {
          type: HookType.AGGREGATION,
          hooks: [
            delayedFlowHookNode(signer.address),
            { type: HookType.MERKLE_TREE },
          ],
        },
      };

      await sendTxs(await warpModule.update(expectedConfig));

      const readConfig = await warpModule.read();
      assert(
        typeof readConfig.hook === 'object' &&
          readConfig.hook.type === HookType.AGGREGATION,
        'Expected the aggregation hook to round-trip',
      );
      expect(
        readConfig.hook.hooks.some(
          (hook) =>
            typeof hook === 'object' &&
            hook.type === HookType.DELAYED_FLOW_ROUTER,
        ),
      ).to.be.true;

      const { deployedTokenRoute } = warpModule.serialize();
      const deployConfig: WarpRouteDeployConfigMailboxRequired = {
        [chain]: {
          ...baseConfig,
          type: TokenType.collateral,
          token: token.address,
          interchainSecurityModule: delayedFlowIsm(signer.address),
        },
      };
      const targets = await deriveDelayedFlowEnrollmentTargets(
        multiProvider,
        deployConfig,
        { [chain]: deployedTokenRoute },
      );
      const delayedHook = readConfig.hook.hooks.find(
        (hook) =>
          typeof hook === 'object' &&
          hook.type === HookType.DELAYED_FLOW_ROUTER,
      );
      assert(
        delayedHook &&
          typeof delayedHook === 'object' &&
          'address' in delayedHook,
        'Expected the delayed-flow hook address',
      );
      expect(targets[chain].ismAddress).to.equal(delayedHook.address);
      expect(await warpModule.update(readConfig)).to.deep.equal([]);
    });

    it('rejects an aggregated hybrid when warp apply would retain an existing fee hook', async () => {
      const warpModule = await createPlainRoute();
      const feeHook = randomAddress();
      await sendTxs(
        await warpModule.update({
          ...(await warpModule.read()),
          feeHook,
        }),
      );

      const actualConfig = await warpModule.read();
      expect(
        actualConfig.feeHook && eqAddress(actualConfig.feeHook, feeHook),
      ).to.equal(true);
      const expectedConfig: HypTokenRouterConfig = {
        ...actualConfig,
        // Omission means "leave unchanged" during warp apply.
        feeHook: undefined,
        interchainSecurityModule: delayedFlowIsm(signer.address),
        hook: {
          type: HookType.AGGREGATION,
          hooks: [
            delayedFlowHookNode(signer.address),
            { type: HookType.MERKLE_TREE },
          ],
        },
        tokenFee: {
          type: TokenFeeType.LinearFee,
          owner: signer.address,
          bps: 100,
        },
      };
      const nonceBefore = await signer.getTransactionCount();

      await expect(warpModule.update(expectedConfig)).to.be.rejectedWith(
        'cannot be combined with non-zero feeHook',
      );
      await expect(
        warpModule.update({
          ...expectedConfig,
          feeHook: ethers.constants.AddressZero,
        }),
      ).to.be.rejectedWith('while clearing existing feeHook');
      expect(await signer.getTransactionCount()).to.equal(nonceBefore);
    });

    it('requires fee-hook clearing before replacing or recomposing an installed delayed-flow hook', async () => {
      const warpModule = await createPlainRoute();
      const initialConfig: HypTokenRouterConfig = {
        ...(await warpModule.read()),
        interchainSecurityModule: delayedFlowIsm(signer.address),
        hook: delayedFlowHookNode(signer.address),
      };
      await sendTxs(await warpModule.update(initialConfig));

      const { deployedTokenRoute } = warpModule.serialize();
      const feeHook = randomAddress();
      await TokenRouter__factory.connect(deployedTokenRoute, signer).setFeeHook(
        feeHook,
      );
      const actualConfig = await warpModule.read();
      assert(
        typeof actualConfig.hook === 'object' &&
          actualConfig.hook.type === HookType.DELAYED_FLOW_ROUTER,
        'Expected an installed delayed-flow hook',
      );
      const nonceBefore = await signer.getTransactionCount();

      await expect(
        warpModule.update({
          ...actualConfig,
          feeHook: ethers.constants.AddressZero,
          interchainSecurityModule: delayedFlowIsm(signer.address, 7200),
          hook: delayedFlowHookNode(signer.address, 7200),
        }),
      ).to.be.rejectedWith('introduce, replace, or recompose');
      await expect(
        warpModule.update({
          ...actualConfig,
          feeHook: ethers.constants.AddressZero,
          hook: {
            type: HookType.AGGREGATION,
            hooks: [actualConfig.hook, { type: HookType.MERKLE_TREE }],
          },
        }),
      ).to.be.rejectedWith('introduce, replace, or recompose');
      expect(await signer.getTransactionCount()).to.equal(nonceBefore);

      const clearTxs = await warpModule.update({
        ...actualConfig,
        feeHook: ethers.constants.AddressZero,
      });
      expect(
        clearTxs.some(
          (tx) =>
            tx.data?.startsWith(
              MailboxClient__factory.createInterface().getSighash('setHook'),
            ) ?? false,
        ),
      ).to.equal(false);
      await sendTxs(clearTxs);
      expect((await warpModule.read()).feeHook).to.equal(undefined);
    });

    it('rejects an existing hybrid owned separately from its router', async () => {
      const warpModule = await createPlainRoute();
      const { deployedTokenRoute } = warpModule.serialize();
      const expectedConfig: HypTokenRouterConfig = {
        ...(await warpModule.read()),
        interchainSecurityModule: delayedFlowIsm(signer.address),
        hook: delayedFlowHookNode(signer.address),
      };

      await sendTxs(await warpModule.update(expectedConfig));
      const client = MailboxClient__factory.connect(
        deployedTokenRoute,
        multiProvider.getProvider(chain),
      );
      const hybrid = DelayedFlowRouterHookIsm__factory.connect(
        await client.hook(),
        signer,
      );
      const separateOwner = randomAddress();
      await hybrid.transferOwnership(separateOwner);

      await expect(warpModule.update(expectedConfig)).to.be.rejectedWith(
        'is owned by',
      );
    });

    it('hands a replacement hybrid and its router to the new owner last', async () => {
      const warpModule = await createPlainRoute();
      const initialConfig: HypTokenRouterConfig = {
        ...(await warpModule.read()),
        interchainSecurityModule: delayedFlowIsm(signer.address),
        hook: delayedFlowHookNode(signer.address),
      };
      await sendTxs(await warpModule.update(initialConfig));

      const newOwner = randomAddress();
      const expectedConfig: HypTokenRouterConfig = {
        ...(await warpModule.read()),
        owner: newOwner,
        interchainSecurityModule: delayedFlowIsm(newOwner, 7200),
        hook: delayedFlowHookNode(newOwner, 7200),
      };
      const phases = await warpModule.updatePhases(expectedConfig);
      expect(phases.ownershipTxs).to.have.length(2);

      await sendTxs([
        ...phases.upgradeTxs,
        ...phases.instanceTxs,
        ...phases.hookTxs,
        ...phases.ismTxs,
        ...phases.txs,
        ...phases.feeTxs,
        ...phases.ownershipTxs,
      ]);

      const actual = await warpModule.read();
      expect(eqAddress(actual.owner, newOwner)).to.be.true;
      const hybrid = collectHybridIsmNodes(actual.interchainSecurityModule)[0];
      assert(
        hybrid.type === IsmType.DELAYED_FLOW_ROUTER,
        'Expected delayed-flow hybrid',
      );
      expect(hybrid.owner && eqAddress(hybrid.owner, newOwner)).to.be.true;
      expect(hybrid.maxDelay).to.equal(7200);
    });

    it('returns hybrid instance mutations before installation and ownership', async () => {
      const warpModule = await createPlainRoute();
      const initialConfig: HypTokenRouterConfig = {
        ...(await warpModule.read()),
        interchainSecurityModule: delayedFlowIsm(signer.address),
        hook: delayedFlowHookNode(signer.address),
      };
      await sendTxs(await warpModule.update(initialConfig));

      const instanceTx: AnnotatedEV5Transaction = {
        chainId: Number(multiProvider.getChainId(chain)),
        to: randomAddress(),
        data: '0x1234',
      };
      const updateStub = sinon
        .stub(EvmIsmModule.prototype, 'updateDeployedInstance')
        .resolves([instanceTx]);

      try {
        const currentConfig = await warpModule.read();
        const currentHybrid = collectHybridIsmNodes(
          currentConfig.interchainSecurityModule,
        )[0];
        assert(
          currentHybrid && 'address' in currentHybrid,
          'Expected an installed delayed-flow hybrid',
        );
        const targetConfig: HypTokenRouterConfig = {
          ...currentConfig,
          interchainSecurityModule: delayedFlowIsm(signer.address),
          hook: delayedFlowHookNode(signer.address),
        };
        const phases = await warpModule.updatePhases(targetConfig);
        expect(updateStub.calledOnce).to.be.true;
        expect(phases.instanceTxs).to.deep.equal([instanceTx]);
        expect(phases.ownershipTxs).not.to.include(instanceTx);
      } finally {
        updateStub.restore();
      }
    });

    it('resumes after hybrid ownership transfers but router ownership does not', async () => {
      const warpModule = await createPlainRoute();
      const initialConfig: HypTokenRouterConfig = {
        ...(await warpModule.read()),
        interchainSecurityModule: delayedFlowIsm(signer.address),
        hook: delayedFlowHookNode(signer.address),
      };
      await sendTxs(await warpModule.update(initialConfig));

      const newOwner = randomAddress();
      const expectedConfig: HypTokenRouterConfig = {
        ...(await warpModule.read()),
        owner: newOwner,
        interchainSecurityModule: delayedFlowIsm(newOwner),
        hook: delayedFlowHookNode(newOwner),
      };
      const interruptedPhases = await warpModule.updatePhases(expectedConfig);
      expect(interruptedPhases.ownershipTxs).to.have.length(2);

      await sendTxs([interruptedPhases.ownershipTxs[0]]);

      const nonceBeforeRejectedChange = await signer.getTransactionCount();
      await expect(
        warpModule.updatePhases({
          ...expectedConfig,
          interchainSecurityModule: delayedFlowIsm(newOwner, 7200),
          hook: delayedFlowHookNode(newOwner, 7200),
        }),
      ).to.be.rejectedWith('was already transferred to the target owner');
      expect(await signer.getTransactionCount()).to.equal(
        nonceBeforeRejectedChange,
      );

      const resumedPhases = await warpModule.updatePhases(expectedConfig);
      expect(resumedPhases.ownershipTxs).to.have.length(1);
      await sendTxs(resumedPhases.ownershipTxs);

      const actual = await warpModule.read();
      expect(eqAddress(actual.owner, newOwner)).to.be.true;
      const hybrid = collectHybridIsmNodes(actual.interchainSecurityModule)[0];
      assert(
        hybrid.type === IsmType.DELAYED_FLOW_ROUTER,
        'Expected delayed-flow hybrid',
      );
      expect(hybrid.owner && eqAddress(hybrid.owner, newOwner)).to.be.true;
    });
  });

  describe('createHookUpdateTxs', () => {
    const ROUTE_ADDRESS = '0x1111111111111111111111111111111111111111';
    const TOKEN_ADDRESS = '0x2222222222222222222222222222222222222222';

    let warpModule: EvmWarpModule;

    before(() => {
      warpModule = new EvmWarpModule(multiProvider, {
        chain,
        config: {} as HypTokenRouterConfig,
        addresses: {
          deployedTokenRoute: ROUTE_ADDRESS,
          ...ismFactoryAddresses,
        },
      });
    });

    it('returns empty when expected hook is AddressZero', async () => {
      const actual = {
        ...baseConfig,
        type: TokenType.collateral,
        token: TOKEN_ADDRESS,
      } as DerivedTokenRouterConfig;
      const expected = {
        ...baseConfig,
        type: TokenType.collateral,
        token: TOKEN_ADDRESS,
        hook: ethers.constants.AddressZero,
      } as HypTokenRouterConfig;

      expect(
        await warpModule.createHookUpdateTxs(actual, expected),
      ).to.deep.equal([]);
    });
  });
});
