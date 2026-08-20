import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';
import sinon from 'sinon';

import {
  AtomicLocalRebalancingBridge__factory,
  CrossCollateralRouter__factory,
  DelayedFlowRouterHookIsm__factory,
  ERC20Test,
  ERC20Test__factory,
  GasRouter__factory,
  HypXERC20Lockbox__factory,
  LinearFee__factory,
  MailboxClient__factory,
  NetFlowRateLimitedHookIsm__factory,
  ProxyAdmin,
  ProxyAdmin__factory,
  RateLimitedIsm__factory,
  RoutingFee__factory,
  StaticAggregationIsm__factory,
  TokenRouter__factory,
  TransparentUpgradeableProxy__factory,
  XERC20LockboxTest__factory,
  XERC20Test,
  XERC20Test__factory,
} from '@hyperlane-xyz/core';
import {
  Address,
  ProtocolType,
  addressToBytes32,
  assert,
  deepCopy,
  eqAddress,
  isZeroishAddress,
  objMap,
} from '@hyperlane-xyz/utils';

import { TestChainName } from '../consts/testChains.js';
import { TestCoreApp } from '../core/TestCoreApp.js';
import { TestCoreDeployer } from '../core/TestCoreDeployer.js';
import { HyperlaneProxyFactoryDeployer } from '../deploy/HyperlaneProxyFactoryDeployer.js';
import { enrollCrossChainRouters, executeWarpDeploy } from '../deploy/warp.js';
import { TokenFeeType } from '../fee/types.js';
import { HookConfig, HookType } from '../hook/types.js';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
import {
  AggregationIsmConfig,
  DelayedFlowRouterHookIsmConfig,
  IsmConfig,
  IsmType,
  NetFlowRateLimitedHookIsmConfig,
  RateLimitedIsmConfig,
} from '../ism/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import {
  AnnotatedEV5Transaction,
  TypedAnnotatedTransaction,
} from '../providers/ProviderType.js';
import { randomAddress } from '../test/testUtils.js';
import { ChainMap } from '../types.js';
import { collectHybridIsmNodes } from '../utils/ism.js';

import { EvmWarpRouteReader } from './EvmWarpRouteReader.js';
import { TokenStandard } from './TokenStandard.js';
import { TokenType } from './config.js';
import { checkWarpRouteDeployConfig } from './warpCheck.js';
import { HypERC20Deployer } from './deploy.js';
import {
  SyntheticTokenConfig,
  WarpRouteDeployConfigMailboxRequired,
  isAtomicLocalRebalancingBridgeTokenConfig,
  isDepositAddressTokenConfig,
} from './types.js';
import { WarpCoreConfig } from '../warp/types.js';

const chain = TestChainName.test1;

function addOverridesToConfig(
  config: WarpRouteDeployConfigMailboxRequired,
  ownerOverrides: Record<string, string>,
): WarpRouteDeployConfigMailboxRequired {
  return Object.fromEntries(
    Object.entries(config).map(([chain, config]) => {
      return [
        chain,
        {
          ...config,
          ownerOverrides,
        },
      ];
    }),
  );
}

function assertEvmTransaction(
  transaction: TypedAnnotatedTransaction,
  chain: string,
): asserts transaction is AnnotatedEV5Transaction {
  assert(
    'to' in transaction &&
      typeof transaction.to === 'string' &&
      'data' in transaction &&
      typeof transaction.data === 'string',
    `Expected an EVM transaction for ${chain}`,
  );
}

describe('TokenDeployer', async () => {
  let signer: SignerWithAddress;
  let deployer: HypERC20Deployer;
  let multiProvider: MultiProvider;
  let coreApp: TestCoreApp;
  let config: WarpRouteDeployConfigMailboxRequired;
  let token: Address;
  let xerc20: XERC20Test;
  let erc20: ERC20Test;
  let admin: ProxyAdmin;
  const totalSupply = '100000';

  before(async () => {
    [signer] = await hre.ethers.getSigners();
    multiProvider = MultiProvider.createTestMultiProvider({ signer });
    for (const chainName of multiProvider.getKnownChainNames()) {
      multiProvider.metadata[chainName] = {
        ...multiProvider.metadata[chainName],
        blockExplorers: [],
      };
    }
    const ismFactoryDeployer = new HyperlaneProxyFactoryDeployer(multiProvider);
    const factories = await ismFactoryDeployer.deploy(
      multiProvider.mapKnownChains(() => ({})),
    );
    const ismFactory = new HyperlaneIsmFactory(factories, multiProvider);
    coreApp = await new TestCoreDeployer(multiProvider, ismFactory).deployApp();
    const routerConfigMap = coreApp.getRouterConfig(signer.address);
    const token: SyntheticTokenConfig = {
      type: TokenType.synthetic,
      name: chain,
      symbol: `u${chain}`,
      decimals: 18,
    };
    config = objMap(routerConfigMap, (chain, c) => ({
      ...token,
      ...c,
    }));
  });

  beforeEach(async () => {
    const { name, decimals, symbol } = config[chain];
    const implementation = await new XERC20Test__factory(signer).deploy(
      name!,
      symbol!,
      totalSupply!,
      decimals!,
    );
    admin = await new ProxyAdmin__factory(signer).deploy();
    const proxy = await new TransparentUpgradeableProxy__factory(signer).deploy(
      implementation.address,
      admin.address,
      XERC20Test__factory.createInterface().encodeFunctionData('initialize'),
    );
    token = proxy.address;
    xerc20 = XERC20Test__factory.connect(token, signer);
    erc20 = await new ERC20Test__factory(signer).deploy(
      name!,
      symbol!,
      totalSupply!,
      decimals!,
    );

    deployer = new HypERC20Deployer(multiProvider);
  });

  it('deploys', async () => {
    await deployer.deploy(config);
  });

  it('deploys a deposit-address bridge and derives its config', async () => {
    const depositAddress = ethers.Wallet.createRandom().address;
    const recipient = ethers.utils.hexZeroPad(
      ethers.Wallet.createRandom().address,
      32,
    );

    const depositConfig: WarpRouteDeployConfigMailboxRequired = {
      [chain]: {
        ...config[chain],
        type: TokenType.collateralDepositAddress,
        token: erc20.address,
        destinationConfigs: {
          [TestChainName.test2]: {
            [recipient]: {
              depositAddress,
              feeBps: '1000',
            },
          },
        },
      },
    };

    const contracts = await deployer.deploy(depositConfig);
    const routerAddress =
      contracts[chain][TokenType.collateralDepositAddress].address;

    const reader = new EvmWarpRouteReader(multiProvider, chain);
    const derivedConfig = await reader.deriveWarpRouteConfig(routerAddress);

    expect(derivedConfig.type).to.equal(TokenType.collateralDepositAddress);
    if (!isDepositAddressTokenConfig(derivedConfig)) {
      throw new Error('Expected deposit-address token config');
    }
    expect(derivedConfig.token).to.equal(erc20.address);
    expect(derivedConfig.mailbox).to.equal(ethers.constants.AddressZero);
    expect(derivedConfig.hook).to.equal(ethers.constants.AddressZero);
    expect(derivedConfig.interchainSecurityModule).to.equal(
      ethers.constants.AddressZero,
    );
    expect(derivedConfig.remoteRouters).to.deep.equal({});
    expect(derivedConfig.destinationConfigs).to.deep.equal({
      [multiProvider.getDomainId(TestChainName.test2).toString()]: {
        [recipient.toLowerCase()]: {
          depositAddress,
          feeBps: '1000',
        },
      },
    });
  });

  it('deploys an atomic local rebalancing bridge with its immutable source and configured owner', async () => {
    const bridgeOwner = ethers.Wallet.createRandom().address;
    const sourceRouter = await new CrossCollateralRouter__factory(
      signer,
    ).deploy(erc20.address, 1, 1, config[chain].mailbox);
    await sourceRouter.initialize(
      ethers.constants.AddressZero,
      ethers.constants.AddressZero,
      signer.address,
    );
    const atomicConfig: WarpRouteDeployConfigMailboxRequired = {
      [chain]: {
        mailbox: config[chain].mailbox,
        type: TokenType.atomicLocalRebalancing,
        sourceRouter: sourceRouter.address,
        owner: bridgeOwner,
      },
    };

    const contracts = await deployer.deploy(atomicConfig);
    const bridgeAddress =
      contracts[chain][TokenType.atomicLocalRebalancing].address;
    const bridge = AtomicLocalRebalancingBridge__factory.connect(
      bridgeAddress,
      signer,
    );

    expect(await bridge.localDomain()).to.equal(
      multiProvider.getDomainId(chain),
    );
    expect(await bridge.allowedSourceRouter()).to.equal(sourceRouter.address);
    expect(await bridge.owner()).to.equal(bridgeOwner);

    const reader = new EvmWarpRouteReader(multiProvider, chain);
    const derivedConfig = await reader.deriveWarpRouteConfig(bridgeAddress);
    expect(derivedConfig.type).to.equal(TokenType.atomicLocalRebalancing);
    if (!isAtomicLocalRebalancingBridgeTokenConfig(derivedConfig)) {
      throw new Error('Expected atomic local rebalancing bridge config');
    }
    expect(derivedConfig.sourceRouter).to.equal(sourceRouter.address);
    expect(derivedConfig.name).to.equal(await erc20.name());
    expect(derivedConfig.symbol).to.equal(await erc20.symbol());
    expect(derivedConfig.decimals).to.equal(await erc20.decimals());
    expect(derivedConfig.owner).to.equal(bridgeOwner);
    expect(derivedConfig.mailbox).to.equal(ethers.constants.AddressZero);
    expect(derivedConfig.remoteRouters).to.deep.equal({});

    const warpCoreConfig: WarpCoreConfig = {
      tokens: [
        {
          chainName: chain,
          addressOrDenom: bridgeAddress,
          decimals: await erc20.decimals(),
          name: await erc20.name(),
          standard: TokenStandard.EvmAtomicLocalRebalancingBridge,
          symbol: await erc20.symbol(),
          tokenType: TokenType.atomicLocalRebalancing,
        },
      ],
    };
    const checkResult = await checkWarpRouteDeployConfig({
      multiProvider,
      warpCoreConfig,
      warpDeployConfig: atomicConfig,
    });
    expect(checkResult.isValid, JSON.stringify(checkResult, null, 2)).to.equal(
      true,
    );
    expect(checkResult.violations).to.deep.equal([]);
  });

  it('rejects an atomic bridge deployed for the wrong local domain', async () => {
    const sourceRouter = await new CrossCollateralRouter__factory(
      signer,
    ).deploy(erc20.address, 1, 1, config[chain].mailbox);
    const wrongDomain = multiProvider.getDomainId(chain) + 1;
    const bridge = await new AtomicLocalRebalancingBridge__factory(
      signer,
    ).deploy(wrongDomain, sourceRouter.address, signer.address);

    const reader = new EvmWarpRouteReader(multiProvider, chain);
    let error: unknown;
    try {
      await reader.deriveWarpRouteConfig(bridge.address);
    } catch (caught) {
      error = caught;
    }
    expect(error).to.be.instanceOf(Error);
    if (!(error instanceof Error)) {
      throw new Error('Expected local domain mismatch error');
    }
    expect(error.message).to.include(
      `localDomain ${wrongDomain} does not match`,
    );
  });

  it('transfers an atomic local rebalancing bridge to its configured owner through executeWarpDeploy', async () => {
    const bridgeOwner = ethers.Wallet.createRandom().address;
    const sourceRouter = await new CrossCollateralRouter__factory(
      signer,
    ).deploy(erc20.address, 1, 1, config[chain].mailbox);
    await sourceRouter.initialize(
      ethers.constants.AddressZero,
      ethers.constants.AddressZero,
      signer.address,
    );
    const atomicConfig: WarpRouteDeployConfigMailboxRequired = {
      [chain]: {
        ...config[chain],
        type: TokenType.atomicLocalRebalancing,
        sourceRouter: sourceRouter.address,
        owner: bridgeOwner,
      },
    };

    const deployedContracts = await executeWarpDeploy(
      atomicConfig,
      multiProvider,
      {},
      { [chain]: coreApp.getAddresses(chain) },
      {},
    );
    const bridge = AtomicLocalRebalancingBridge__factory.connect(
      deployedContracts[chain],
      signer,
    );

    expect(await bridge.owner()).to.equal(bridgeOwner);
  });

  it('applies rebalance targets and recipients during fresh deployment', async () => {
    const localDomain = multiProvider.getDomainId(chain);
    const localRouter = addressToBytes32(
      '0x1111111111111111111111111111111111111111',
    );
    const target = addressToBytes32(
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    const recipient = addressToBytes32(
      '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    );
    const crossCollateralConfig: WarpRouteDeployConfigMailboxRequired = {
      [chain]: {
        ...config[chain],
        type: TokenType.crossCollateral,
        token: erc20.address,
        crossCollateralRouters: { [localDomain]: [localRouter] },
        rebalanceTargets: { [localDomain]: [target] },
        rebalanceRecipients: { [localDomain]: recipient },
      },
    };

    const contracts = await deployer.deploy(crossCollateralConfig);
    const router = CrossCollateralRouter__factory.connect(
      contracts[chain][TokenType.crossCollateral].address,
      signer,
    );

    expect(
      (await router.rebalanceTargets(localDomain)).map((value) =>
        value.toLowerCase(),
      ),
    ).to.deep.equal([target]);
    expect((await router.allowedRecipient(localDomain)).toLowerCase()).to.equal(
      recipient,
    );
  });

  it('deploys mixed deposit-address and router configs', async () => {
    const depositAddress = ethers.Wallet.createRandom().address;
    const recipient = ethers.utils.hexZeroPad(
      ethers.Wallet.createRandom().address,
      32,
    );

    const mixedConfig: WarpRouteDeployConfigMailboxRequired = {
      [TestChainName.test1]: {
        ...config[TestChainName.test1],
        type: TokenType.collateralDepositAddress,
        token: erc20.address,
        destinationConfigs: {
          [TestChainName.test2]: {
            [recipient]: {
              depositAddress,
              feeBps: '1000',
            },
          },
        },
      },
      [TestChainName.test2]: {
        ...config[TestChainName.test2],
        type: TokenType.synthetic,
      },
    };

    const contracts = await deployer.deploy(mixedConfig);
    expect(
      contracts[TestChainName.test1][TokenType.collateralDepositAddress]
        .address,
    ).to.not.equal(ethers.constants.AddressZero);
    expect(
      contracts[TestChainName.test2][TokenType.synthetic].address,
    ).to.not.equal(ethers.constants.AddressZero);

    const reader = new EvmWarpRouteReader(multiProvider, TestChainName.test1);
    const derivedConfig = await reader.deriveWarpRouteConfig(
      contracts[TestChainName.test1][TokenType.collateralDepositAddress]
        .address,
    );

    if (!isDepositAddressTokenConfig(derivedConfig)) {
      throw new Error('Expected deposit-address token config');
    }
    expect(derivedConfig.destinationConfigs).to.deep.equal({
      [multiProvider.getDomainId(TestChainName.test2).toString()]: {
        [recipient.toLowerCase()]: {
          depositAddress,
          feeBps: '1000',
        },
      },
    });
  });

  for (const type of [
    TokenType.collateral,
    TokenType.synthetic,
    TokenType.XERC20,
  ]) {
    const token = () => {
      switch (type) {
        case TokenType.XERC20:
          return xerc20.address;
        case TokenType.collateral:
          return erc20.address;
        default:
          return undefined;
      }
    };

    describe('checkWarpRouteDeployConfig', async () => {
      let contractsMap: Awaited<ReturnType<HypERC20Deployer['deploy']>>;
      const getRouterAddress = (currentChain: string) =>
        contractsMap[currentChain][config[currentChain].type].address;

      const getWarpCoreConfig = (): WarpCoreConfig =>
        ({
          tokens: Object.keys(config).map((currentChain) => ({
            addressOrDenom: getRouterAddress(currentChain),
            chainName: currentChain,
          })),
        }) as WarpCoreConfig;

      beforeEach(async () => {
        // @ts-expect-error - Test assigns varying token types to config
        config[chain] = {
          ...config[chain],
          type,
          token: token(),
        };

        contractsMap = await deployer.deploy(config);
      });

      it(`should have no violations on clean deploy of ${type}`, async () => {
        const result = await checkWarpRouteDeployConfig({
          multiProvider,
          warpCoreConfig: getWarpCoreConfig(),
          warpDeployConfig: config,
        });

        expect(result.isValid).to.equal(true);
        expect(result.violations).to.deep.equal([]);
      });

      it('should ignore warp core config chains unknown to the multiprovider', async () => {
        const unknownChain = 'deprecated-chain';
        const unknownWarpCoreConfig = {
          tokens: [
            ...getWarpCoreConfig().tokens,
            {
              addressOrDenom: ethers.Wallet.createRandom().address,
              chainName: unknownChain,
            },
          ],
        } as WarpCoreConfig;

        const result = await checkWarpRouteDeployConfig({
          multiProvider,
          warpCoreConfig: unknownWarpCoreConfig,
          warpDeployConfig: config,
        });

        expect(result.isValid).to.equal(true);
        expect(result.violations).to.deep.equal([]);
      });

      it('should ignore non-EVM route members when expanding EVM configs', async () => {
        const cosmosChain = 'testcosmos';
        if (!multiProvider.tryGetChainMetadata(cosmosChain)) {
          multiProvider.addChain({
            chainId: 'testcosmos-1',
            domainId: 919191,
            name: cosmosChain,
            protocol: ProtocolType.Cosmos,
            rpcUrls: [{ http: 'https://cosmos.example.com' }],
            bech32Prefix: 'cosmos',
            slip44: 118,
            restUrls: [],
            grpcUrls: [],
          });
        }

        const mixedWarpDeployConfig = deepCopy(config);
        mixedWarpDeployConfig[cosmosChain] = {
          type: TokenType.synthetic,
          mailbox:
            '0x0000000000000000000000000000000000000000000000000000000000000001',
          owner: signer.address,
          gas: 12345,
          name: 'Test Cosmos',
          symbol: 'TCOSM',
          decimals: 18,
        };

        const cosmosRouterAddress =
          '0x0000000000000000000000000000000000000000000000000000000000000002';
        const cosmosGas = 12345;

        const mixedWarpCoreConfig = {
          tokens: [
            ...getWarpCoreConfig().tokens,
            {
              addressOrDenom: cosmosRouterAddress,
              chainName: cosmosChain,
            },
          ],
        } as WarpCoreConfig;
        const cosmosDomain = multiProvider.getDomainId(cosmosChain);
        for (const currentChain of Object.keys(config)) {
          const tokenRouter = TokenRouter__factory.connect(
            getRouterAddress(currentChain),
            signer,
          );
          await tokenRouter.enrollRemoteRouter(
            cosmosDomain,
            cosmosRouterAddress,
          );

          const gasRouter = GasRouter__factory.connect(
            getRouterAddress(currentChain),
            signer,
          );
          await gasRouter['setDestinationGas(uint32,uint256)'](
            cosmosDomain,
            cosmosGas,
          );
        }

        const result = await checkWarpRouteDeployConfig({
          multiProvider,
          warpCoreConfig: mixedWarpCoreConfig,
          warpDeployConfig: mixedWarpDeployConfig,
        });

        expect(result.isValid).to.equal(true);
        expect(result.violations).to.deep.equal([]);
      });

      it('should include non-EVM route members in scale validation', async () => {
        const cosmosChain = 'testcosmos';
        if (!multiProvider.tryGetChainMetadata(cosmosChain)) {
          multiProvider.addChain({
            chainId: 'testcosmos-1',
            domainId: 919191,
            name: cosmosChain,
            protocol: ProtocolType.Cosmos,
            rpcUrls: [{ http: 'https://cosmos.example.com' }],
            bech32Prefix: 'cosmos',
            slip44: 118,
            restUrls: [],
            grpcUrls: [],
          });
        }

        const mixedWarpDeployConfig = deepCopy(config);
        mixedWarpDeployConfig[cosmosChain] = {
          type: TokenType.synthetic,
          mailbox:
            '0x0000000000000000000000000000000000000000000000000000000000000001',
          owner: signer.address,
          gas: 12345,
          name: 'Test Cosmos',
          symbol: 'TCOSM',
          decimals: 6,
        };

        const mixedWarpCoreConfig = {
          tokens: [
            ...getWarpCoreConfig().tokens,
            {
              addressOrDenom:
                '0x0000000000000000000000000000000000000000000000000000000000000002',
              chainName: cosmosChain,
            },
          ],
        } as WarpCoreConfig;

        const result = await checkWarpRouteDeployConfig({
          multiProvider,
          warpCoreConfig: mixedWarpCoreConfig,
          warpDeployConfig: mixedWarpDeployConfig,
        });

        expect(result.isValid).to.equal(false);
        expect(result.scaleViolations).to.deep.equal([
          {
            actual: 'invalid-or-missing',
            chain: 'route',
            expected: 'consistent-with-decimals',
            name: 'scale',
            type: 'ScaleMismatch',
          },
        ]);
      });

      it('should fail fast for pure non-EVM route subsets', async () => {
        const cosmosChain = 'testcosmos';
        if (!multiProvider.tryGetChainMetadata(cosmosChain)) {
          multiProvider.addChain({
            chainId: 'testcosmos-1',
            domainId: 919191,
            name: cosmosChain,
            protocol: ProtocolType.Cosmos,
            rpcUrls: [{ http: 'https://cosmos.example.com' }],
            bech32Prefix: 'cosmos',
            slip44: 118,
            restUrls: [],
            grpcUrls: [],
          });
        }

        const cosmosOnlyWarpDeployConfig = {
          [cosmosChain]: {
            type: TokenType.synthetic,
            mailbox:
              '0x0000000000000000000000000000000000000000000000000000000000000001',
            owner: signer.address,
            gas: 12345,
            name: 'Test Cosmos',
            symbol: 'TCOSM',
            decimals: 18,
          },
        } as WarpRouteDeployConfigMailboxRequired;

        const cosmosOnlyWarpCoreConfig = {
          tokens: [
            {
              addressOrDenom:
                '0x0000000000000000000000000000000000000000000000000000000000000002',
              chainName: cosmosChain,
            },
          ],
        } as WarpCoreConfig;

        try {
          await checkWarpRouteDeployConfig({
            multiProvider,
            warpCoreConfig: cosmosOnlyWarpCoreConfig,
            warpDeployConfig: cosmosOnlyWarpDeployConfig,
          });
          expect.fail('Expected pure non-EVM route subset to reject');
        } catch (error) {
          expect((error as Error).message).to.contain(
            'Warp route check requires at least one EVM or supported altVM chain in the selected route config',
          );
        }
      });

      it('should ignore collateral owner changes when ownerOverrides is unset', async () => {
        if (type !== TokenType.XERC20) {
          return;
        }

        await xerc20.transferOwnership(ethers.Wallet.createRandom().address);
        await admin.transferOwnership(ethers.Wallet.createRandom().address);

        const result = await checkWarpRouteDeployConfig({
          multiProvider,
          warpCoreConfig: getWarpCoreConfig(),
          warpDeployConfig: config,
        });

        expect(result.isValid).to.equal(true);
        expect(
          result.violations.some((violation) =>
            [
              'ownerOverrides.collateralToken',
              'ownerOverrides.collateralProxyAdmin',
            ].includes(violation.name),
          ),
        ).to.equal(false);
      });

      it('should skip collateralToken override checks for non-Ownable collateral tokens', async () => {
        if (type !== TokenType.collateral) {
          return;
        }

        const overrideConfig = addOverridesToConfig(config, {
          collateralToken: ethers.Wallet.createRandom().address,
        });

        const result = await checkWarpRouteDeployConfig({
          multiProvider,
          warpCoreConfig: getWarpCoreConfig(),
          warpDeployConfig: overrideConfig,
        });

        expect(
          result.violations.some(
            (violation) =>
              violation.chain === chain &&
              violation.name === 'ownerOverrides.collateralToken',
          ),
        ).to.equal(false);
      });

      it('should flag explicit proxyAdmin address mismatches', async () => {
        const explicitProxyAdminConfig = deepCopy(config);
        explicitProxyAdminConfig[chain].proxyAdmin = {
          address: ethers.Wallet.createRandom().address,
          owner: explicitProxyAdminConfig[chain].owner,
        };

        const result = await checkWarpRouteDeployConfig({
          multiProvider,
          warpCoreConfig: getWarpCoreConfig(),
          warpDeployConfig: explicitProxyAdminConfig,
        });

        expect(result.isValid).to.equal(false);
        expect(
          result.violations.some(
            (violation) =>
              violation.chain === chain &&
              violation.name === 'proxyAdmin.address',
          ),
        ).to.equal(true);
      });

      it('should flag collateral ownership override mismatches', async () => {
        if (type !== TokenType.XERC20) {
          return;
        }

        const overrideConfig = addOverridesToConfig(config, {
          collateralProxyAdmin: await admin.owner(),
          collateralToken: await xerc20.owner(),
        });

        await xerc20.transferOwnership(ethers.Wallet.createRandom().address);
        await admin.transferOwnership(ethers.Wallet.createRandom().address);

        const result = await checkWarpRouteDeployConfig({
          multiProvider,
          warpCoreConfig: getWarpCoreConfig(),
          warpDeployConfig: overrideConfig,
        });

        expect(result.isValid).to.equal(false);
        expect(
          result.violations.some(
            (violation) =>
              violation.chain === chain &&
              violation.name === 'ownerOverrides.collateralToken',
          ),
        ).to.equal(true);
        expect(
          result.violations.some(
            (violation) =>
              violation.chain === chain &&
              violation.name === 'ownerOverrides.collateralProxyAdmin',
          ),
        ).to.equal(true);
      });

      it('should respect ownerOverrides.proxyAdmin over proxyAdmin.owner', async () => {
        const overrideConfig = addOverridesToConfig(config, {
          proxyAdmin: await contractsMap[chain].proxyAdmin.owner(),
        });

        await contractsMap[chain].proxyAdmin.transferOwnership(
          ethers.Wallet.createRandom().address,
        );

        const result = await checkWarpRouteDeployConfig({
          multiProvider,
          warpCoreConfig: getWarpCoreConfig(),
          warpDeployConfig: overrideConfig,
        });

        expect(result.isValid).to.equal(false);
        expect(
          result.violations.some(
            (violation) =>
              violation.chain === chain &&
              violation.name === 'proxyAdmin.owner',
          ),
        ).to.equal(true);
      });
    });

    describe('ERC20WarpRouterReader', async () => {
      let reader: EvmWarpRouteReader;
      let routerAddress: Address;

      before(() => {
        reader = new EvmWarpRouteReader(multiProvider, TestChainName.test1);
      });

      beforeEach(async () => {
        // @ts-expect-error - Test assigns varying token types to config
        config[chain] = {
          ...config[chain],
          type,
          token: token(),
        };
        const warpRoute = await deployer.deploy(config);
        routerAddress = warpRoute[chain][type].address;
      });

      it(`should derive HypTokenRouterConfig correctly`, async () => {
        const derivedConfig = await reader.deriveWarpRouteConfig(routerAddress);
        expect(derivedConfig.type).to.equal(config[chain].type);
      });
    });
  }

  describe('RateLimitedIsm with non-deployer warp owner', () => {
    let ismDeployer: HypERC20Deployer;
    let ismFactory: HyperlaneIsmFactory;

    before(async () => {
      const pfd = new HyperlaneProxyFactoryDeployer(multiProvider);
      const factories = await pfd.deploy(
        multiProvider.mapKnownChains(() => ({})),
      );
      ismFactory = new HyperlaneIsmFactory(factories, multiProvider);
    });

    beforeEach(() => {
      ismDeployer = new HypERC20Deployer(multiProvider, ismFactory);
    });

    it('wires RateLimitedIsm and transfers all ownership when warp owner differs from deployer', async () => {
      const warpOwner = ethers.Wallet.createRandom().address;

      const warpConfig: WarpRouteDeployConfigMailboxRequired = {
        [chain]: {
          ...config[chain],
          type: TokenType.synthetic,
          owner: warpOwner,
        },
      };

      const rateLimitedIsms: Record<string, RateLimitedIsmConfig> = {
        [chain]: {
          type: IsmType.RATE_LIMITED,
          maxCapacity: '86400',
          duration: 86400n,
          owner: warpOwner,
        },
      };

      const contracts = await ismDeployer.deploy(warpConfig, rateLimitedIsms);
      const routerAddress = contracts[chain].synthetic.address;

      // Token ISM should be the deployed RateLimitedIsm
      const tokenClient = MailboxClient__factory.connect(
        routerAddress,
        multiProvider.getProvider(chain),
      );
      const ismAddress = await tokenClient.interchainSecurityModule();
      expect(isZeroishAddress(ismAddress)).to.be.false;

      // RateLimitedIsm owner should be warpOwner, not the deployer
      const rateLimitedIsm = RateLimitedIsm__factory.connect(
        ismAddress,
        multiProvider.getProvider(chain),
      );
      expect((await rateLimitedIsm.owner()).toLowerCase()).to.equal(
        warpOwner.toLowerCase(),
      );

      // Token ownership also transferred to warpOwner
      const router = GasRouter__factory.connect(
        routerAddress,
        multiProvider.getProvider(chain),
      );
      expect((await router.owner()).toLowerCase()).to.equal(
        warpOwner.toLowerCase(),
      );
    });

    it('deploys RateLimitedIsm nested inside staticAggregationIsm and wires it correctly', async () => {
      const warpOwner = ethers.Wallet.createRandom().address;

      const warpConfig: WarpRouteDeployConfigMailboxRequired = {
        [chain]: {
          ...config[chain],
          type: TokenType.synthetic,
          owner: warpOwner,
          // interchainSecurityModule not set — passed via rateLimitedIsms
        },
      };

      const nestedIsmConfig: IsmConfig = {
        type: IsmType.AGGREGATION,
        threshold: 2,
        modules: [
          {
            type: IsmType.PAUSABLE,
            owner: warpOwner,
            paused: false,
          },
          {
            type: IsmType.RATE_LIMITED,
            maxCapacity: '1000000000000000000',
            duration: 86400n,
            owner: warpOwner,
          },
        ],
      } satisfies AggregationIsmConfig;

      const contracts = await ismDeployer.deploy(warpConfig, {
        [chain]: nestedIsmConfig,
      });
      const routerAddress = contracts[chain].synthetic.address;

      // Token ISM must be set (not zero)
      const tokenClient = MailboxClient__factory.connect(
        routerAddress,
        multiProvider.getProvider(chain),
      );
      const ismAddress = await tokenClient.interchainSecurityModule();
      expect(isZeroishAddress(ismAddress)).to.be.false;

      // ISM must be a staticAggregationIsm with threshold 2
      const aggregationIsm = StaticAggregationIsm__factory.connect(
        ismAddress,
        multiProvider.getProvider(chain),
      );
      const [modules, threshold] = await aggregationIsm.modulesAndThreshold(
        ethers.constants.AddressZero,
      );
      expect(threshold).to.equal(2);
      expect(modules).to.have.length(2);

      // Find the RateLimitedIsm module by calling recipient() on each
      let rateLimitedIsmAddress: string | undefined;
      for (const moduleAddress of modules) {
        const candidate = RateLimitedIsm__factory.connect(
          moduleAddress,
          multiProvider.getProvider(chain),
        );
        try {
          const recipient = await candidate.recipient();
          // recipient() succeeds only on RateLimitedIsm
          expect(recipient.toLowerCase()).to.equal(routerAddress.toLowerCase());
          rateLimitedIsmAddress = moduleAddress;
          break;
        } catch {
          // Not a RateLimitedIsm — continue
        }
      }
      expect(rateLimitedIsmAddress).to.not.be.undefined;

      // RateLimitedIsm owner must be warpOwner
      const rateLimitedIsm = RateLimitedIsm__factory.connect(
        rateLimitedIsmAddress!,
        multiProvider.getProvider(chain),
      );
      expect((await rateLimitedIsm.owner()).toLowerCase()).to.equal(
        warpOwner.toLowerCase(),
      );

      // Token ownership transferred to warpOwner
      const router = GasRouter__factory.connect(
        routerAddress,
        multiProvider.getProvider(chain),
      );
      expect((await router.owner()).toLowerCase()).to.equal(
        warpOwner.toLowerCase(),
      );
    });
  });

  describe('Hybrid hook/ISM deferred deploy', () => {
    let registryAddresses: Record<string, Record<string, string>>;

    const remoteChain = TestChainName.test2;

    before(async () => {
      const pfd = new HyperlaneProxyFactoryDeployer(multiProvider);
      const factories = await pfd.deploy(
        multiProvider.mapKnownChains(() => ({})),
      );
      registryAddresses = {};
      for (const chainName of [chain, remoteChain]) {
        registryAddresses[chainName] = {
          ...objMap(factories[chainName], (_, contract) => contract.address),
          mailbox: coreApp.getContracts(chainName).mailbox.address,
        };
      }

      // DELAYED_FLOW_ROUTER refuses nonce-0 mailboxes. Seed both test
      // mailboxes before any staged deploy spends gas.
      for (const [origin, destination] of [
        [chain, remoteChain],
        [remoteChain, chain],
      ] as const) {
        const mailbox = coreApp.getContracts(origin).mailbox;
        if ((await mailbox.nonce()) !== 0) continue;
        const recipient = addressToBytes32(signer.address);
        const quote = await mailbox['quoteDispatch(uint32,bytes32,bytes)'](
          multiProvider.getDomainId(destination),
          recipient,
          '0x',
        );
        await multiProvider.handleTx(
          origin,
          mailbox['dispatch(uint32,bytes32,bytes)'](
            multiProvider.getDomainId(destination),
            recipient,
            '0x',
            { value: quote },
          ),
        );
      }
    });

    function delayedFlowTree(owner: Address): AggregationIsmConfig {
      return {
        type: IsmType.AGGREGATION,
        threshold: 2,
        modules: [
          {
            type: IsmType.TRUSTED_RELAYER,
            relayer: signer.address,
          },
          {
            type: IsmType.DELAYED_FLOW_ROUTER,
            thresholdBps: 10000,
            maxDelay: 3600,
            duration: 86400n,
            owner,
          } satisfies DelayedFlowRouterHookIsmConfig,
        ],
      };
    }

    const hookView = (ism: IsmConfig): HookConfig => {
      const nodes = collectHybridIsmNodes(ism);
      assert(
        nodes.length === 1,
        `Expected one hybrid node, found ${nodes.length}`,
      );
      const node = nodes[0];
      return node.type === IsmType.DELAYED_FLOW_ROUTER
        ? { ...node, type: HookType.DELAYED_FLOW_ROUTER }
        : { ...node, type: HookType.NET_FLOW_RATE_LIMITED };
    };

    async function deployHybridRoute(
      warpConfig: WarpRouteDeployConfigMailboxRequired,
      isms: ChainMap<IsmConfig>,
    ) {
      const planned = objMap(warpConfig, (chainName, chainConfig) => {
        const ism = isms[chainName];
        assert(ism, `Missing hybrid ISM tree for ${chainName}`);
        return {
          ...chainConfig,
          interchainSecurityModule: ism,
          hook: hookView(ism),
        };
      });
      const routers = await executeWarpDeploy(
        planned,
        multiProvider,
        {},
        registryAddresses,
        {},
      );
      return objMap(routers, (_, address) => ({
        synthetic: { address },
      }));
    }

    async function expectDeployRejection(
      promise: Promise<unknown>,
      message: string,
    ): Promise<void> {
      const error = await promise.then(
        () => undefined,
        (thrown: unknown) =>
          thrown instanceof Error ? thrown : new Error(String(thrown)),
      );
      assert(error, 'Expected staged deploy to reject');
      expect(error.message).to.include(message);
    }

    it('wires a nested delayedFlowRouterHookIsm as ISM member AND hook, keeping deployer ownership for enrollment', async () => {
      const warpOwner = ethers.Wallet.createRandom().address;

      const warpConfig: WarpRouteDeployConfigMailboxRequired = {
        [chain]: {
          ...config[chain],
          type: TokenType.synthetic,
          owner: warpOwner,
        },
      };

      const contracts = await deployHybridRoute(warpConfig, {
        [chain]: delayedFlowTree(warpOwner),
      });
      const routerAddress = contracts[chain].synthetic.address;
      const provider = multiProvider.getProvider(chain);

      const tokenClient = MailboxClient__factory.connect(
        routerAddress,
        provider,
      );
      const ismAddress = await tokenClient.interchainSecurityModule();
      expect(isZeroishAddress(ismAddress)).to.be.false;

      // hook must be wired to the hybrid instance
      const hookAddress = await tokenClient.hook();
      expect(isZeroishAddress(hookAddress)).to.be.false;

      // the hook is the DelayedFlowRouterHookIsm paired with this router
      const delayedIsm = DelayedFlowRouterHookIsm__factory.connect(
        hookAddress,
        provider,
      );
      expect(eqAddress(await delayedIsm.warpRouter(), routerAddress)).to.be
        .true;
      expect(await delayedIsm.maxDelay()).to.equal(3600);

      // the same instance must be a member of the aggregation ISM
      const aggregationIsm = StaticAggregationIsm__factory.connect(
        ismAddress,
        provider,
      );
      const [modules] = await aggregationIsm.modulesAndThreshold(
        ethers.constants.AddressZero,
      );
      expect(modules.map((m) => m.toLowerCase())).to.include(
        hookAddress.toLowerCase(),
      );

      // Both stay with the deployer until the final router-enrollment pass.
      expect(eqAddress(await delayedIsm.owner(), signer.address)).to.be.true;
      const router = GasRouter__factory.connect(routerAddress, provider);
      expect((await router.owner()).toLowerCase()).to.equal(
        signer.address.toLowerCase(),
      );
    });

    it('does not proceed to the ISM phase when installing the hook fails', async () => {
      const setHookSighash =
        MailboxClient__factory.createInterface().getSighash('setHook');
      const setIsmSighash = MailboxClient__factory.createInterface().getSighash(
        'setInterchainSecurityModule',
      );
      let sawIsmInstall = false;
      const sendTransaction = multiProvider.sendTransaction.bind(multiProvider);
      const sandbox = sinon.createSandbox();
      sandbox
        .stub(multiProvider, 'sendTransaction')
        .callsFake(async (txChain, txProm, options) => {
          const tx = await txProm;
          if (
            typeof tx.data === 'string' &&
            tx.data.startsWith(setIsmSighash)
          ) {
            sawIsmInstall = true;
          }
          if (
            typeof tx.data === 'string' &&
            tx.data.startsWith(setHookSighash)
          ) {
            throw new Error('execution reverted: setHook');
          }
          return sendTransaction(txChain, tx, options);
        });

      try {
        const warpConfig: WarpRouteDeployConfigMailboxRequired = {
          [chain]: {
            ...config[chain],
            type: TokenType.synthetic,
            owner: signer.address,
          },
        };

        const error = await deployHybridRoute(warpConfig, {
          [chain]: delayedFlowTree(signer.address),
        }).then(
          () => undefined,
          (thrown: unknown) =>
            thrown instanceof Error ? thrown : new Error(String(thrown)),
        );

        assert(error, 'expected the deploy to fail');
        expect(error.message).to.include('execution reverted: setHook');
        expect(sawIsmInstall).to.be.false;
      } finally {
        sandbox.restore();
      }
    });

    it('rejects a hybrid on an unmeterable router type before staged deploy', async () => {
      const warpConfig: WarpRouteDeployConfigMailboxRequired = {
        [chain]: {
          ...config[chain],
          type: TokenType.collateralVault,
          token: erc20.address,
          owner: signer.address,
        },
      };

      await expectDeployRejection(
        deployHybridRoute(warpConfig, {
          [chain]: delayedFlowTree(signer.address),
        }),
        'cannot meter',
      );
    });

    it('rejects a hybrid combined with a predicateWrapper before staged deploy', async () => {
      const warpConfig: WarpRouteDeployConfigMailboxRequired = {
        [chain]: {
          ...config[chain],
          type: TokenType.synthetic,
          owner: signer.address,
          predicateWrapper: {
            predicateRegistry: randomAddress(),
            policyId: 'test-policy',
            owner: signer.address,
          },
        },
      };

      await expectDeployRejection(
        deployHybridRoute(warpConfig, {
          [chain]: delayedFlowTree(signer.address),
        }),
        'both must own',
      );
    });

    it('rejects a top-level netFlowRateLimitedHookIsm (no authenticating ISM)', async () => {
      const warpOwner = ethers.Wallet.createRandom().address;

      const warpConfig: WarpRouteDeployConfigMailboxRequired = {
        [chain]: {
          ...config[chain],
          type: TokenType.synthetic,
          owner: warpOwner,
        },
      };

      // moduleType() is NULL: alone it authenticates nothing, so a forged
      // message would mint on this synthetic leg subject only to bucket
      // capacity. The composition rule must reject it.
      const netFlowConfig: NetFlowRateLimitedHookIsmConfig = {
        type: IsmType.NET_FLOW_RATE_LIMITED,
        thresholdBps: 500,
        duration: 86400n,
        owner: warpOwner,
      };

      await expectDeployRejection(
        deployHybridRoute(warpConfig, { [chain]: netFlowConfig }),
        'verifies flow, not message authenticity',
      );
    });

    it('wires a netFlowRateLimitedHookIsm composed under an authenticating aggregation as both hook and ISM', async () => {
      const warpOwner = ethers.Wallet.createRandom().address;

      const warpConfig: WarpRouteDeployConfigMailboxRequired = {
        [chain]: {
          ...config[chain],
          type: TokenType.synthetic,
          owner: warpOwner,
        },
      };

      const netFlowConfig: AggregationIsmConfig = {
        type: IsmType.AGGREGATION,
        threshold: 2,
        modules: [
          { type: IsmType.TRUSTED_RELAYER, relayer: signer.address },
          {
            type: IsmType.NET_FLOW_RATE_LIMITED,
            thresholdBps: 500,
            duration: 86400n,
            owner: warpOwner,
          },
        ],
      };

      const contracts = await deployHybridRoute(warpConfig, {
        [chain]: netFlowConfig,
      });
      const routerAddress = contracts[chain].synthetic.address;
      const provider = multiProvider.getProvider(chain);

      // Mirror the CLI's post-deploy pass. It enrolls route peers and hands
      // the router, ProxyAdmin, and shared hybrid to their final owner.
      const enrollmentTxs = await enrollCrossChainRouters(
        {
          multiProvider,
          altVmSigners: {},
          registryAddresses,
          warpDeployConfig: warpConfig,
        },
        { [chain]: routerAddress },
      );
      for (const rawTx of enrollmentTxs[chain] ?? []) {
        assertEvmTransaction(rawTx, chain);
        await multiProvider.sendTransaction(chain, {
          to: rawTx.to,
          data: rawTx.data,
          value: rawTx.value,
        });
      }

      const tokenClient = MailboxClient__factory.connect(
        routerAddress,
        provider,
      );
      const ismAddress = await tokenClient.interchainSecurityModule();
      const hookAddress = await tokenClient.hook();
      expect(isZeroishAddress(hookAddress)).to.be.false;

      // The hook is the hybrid leaf inside the installed aggregation, not the
      // aggregation itself.
      const [modules] = await StaticAggregationIsm__factory.connect(
        ismAddress,
        provider,
      ).modulesAndThreshold(ethers.constants.AddressZero);
      expect(modules.map((m) => m.toLowerCase())).to.include(
        hookAddress.toLowerCase(),
      );

      const netFlowIsm = NetFlowRateLimitedHookIsm__factory.connect(
        hookAddress,
        provider,
      );
      expect(eqAddress(await netFlowIsm.warpRouter(), routerAddress)).to.be
        .true;
      // Ownership transfers only after all route wiring is complete.
      expect((await netFlowIsm.owner()).toLowerCase()).to.equal(
        warpOwner.toLowerCase(),
      );
      expect(
        (
          await TokenRouter__factory.connect(routerAddress, provider).owner()
        ).toLowerCase(),
      ).to.equal(warpOwner.toLowerCase());

      const secondEnrollmentTxs = await enrollCrossChainRouters(
        {
          multiProvider,
          altVmSigners: {},
          registryAddresses,
          warpDeployConfig: warpConfig,
        },
        { [chain]: routerAddress },
      );
      expect(Object.keys(secondEnrollmentTxs)).to.have.length(0);
    });

    it('defaults an omitted netFlowRateLimitedHookIsm owner to the chain config owner', async () => {
      const warpOwner = ethers.Wallet.createRandom().address;

      const warpConfig: WarpRouteDeployConfigMailboxRequired = {
        [chain]: {
          ...config[chain],
          type: TokenType.synthetic,
          owner: warpOwner,
        },
      };

      const ownerlessNetFlow: AggregationIsmConfig = {
        type: IsmType.AGGREGATION,
        threshold: 2,
        modules: [
          { type: IsmType.TRUSTED_RELAYER, relayer: signer.address },
          {
            type: IsmType.NET_FLOW_RATE_LIMITED,
            thresholdBps: 500,
            duration: 86400n,
          },
        ],
      };

      const contracts = await deployHybridRoute(warpConfig, {
        [chain]: ownerlessNetFlow,
      });
      const routerAddress = contracts[chain].synthetic.address;
      const provider = multiProvider.getProvider(chain);

      const enrollmentTxs = await enrollCrossChainRouters(
        {
          multiProvider,
          altVmSigners: {},
          registryAddresses,
          warpDeployConfig: warpConfig,
        },
        { [chain]: routerAddress },
      );
      for (const rawTx of enrollmentTxs[chain] ?? []) {
        assertEvmTransaction(rawTx, chain);
        await multiProvider.sendTransaction(chain, {
          to: rawTx.to,
          data: rawTx.data,
          value: rawTx.value,
        });
      }

      // the hybrid leaf is the router's hook; the ISM is the aggregation
      const hookAddress = await MailboxClient__factory.connect(
        routerAddress,
        provider,
      ).hook();
      const netFlowIsm = NetFlowRateLimitedHookIsm__factory.connect(
        hookAddress,
        provider,
      );
      // The final pass defaults an omitted hybrid owner to the chain owner.
      expect((await netFlowIsm.owner()).toLowerCase()).to.equal(
        warpOwner.toLowerCase(),
      );
    });

    it('enrolls delayedFlowRouterHookIsm counterparts cross-chain and transfers ownership last', async () => {
      const warpOwner = ethers.Wallet.createRandom().address;

      const warpDeployConfig: WarpRouteDeployConfigMailboxRequired = {
        [chain]: {
          ...config[chain],
          type: TokenType.synthetic,
          owner: warpOwner,
          interchainSecurityModule: delayedFlowTree(warpOwner),
        },
        [remoteChain]: {
          ...config[remoteChain],
          type: TokenType.synthetic,
          owner: warpOwner,
          interchainSecurityModule: delayedFlowTree(warpOwner),
        },
      };

      const contracts = await deployHybridRoute(warpDeployConfig, {
        [chain]: delayedFlowTree(warpOwner),
        [remoteChain]: delayedFlowTree(warpOwner),
      });
      const deployedContracts = objMap(
        contracts,
        (_, c) => c.synthetic.address,
      );

      const enrollTxs = await enrollCrossChainRouters(
        {
          multiProvider,
          altVmSigners: {},
          registryAddresses,
          warpDeployConfig,
        },
        deployedContracts,
      );
      for (const [txChain, txs] of Object.entries(enrollTxs)) {
        for (const rawTx of txs) {
          assertEvmTransaction(rawTx, txChain);
          // drop the annotated chainId: every hardhat test chain shares one
          // node (chainId 31337) while test-chain metadata carries fake ids
          await multiProvider.sendTransaction(txChain, {
            to: rawTx.to,
            data: rawTx.data,
            value: rawTx.value,
          });
        }
      }

      const localProvider = multiProvider.getProvider(chain);
      const remoteProvider = multiProvider.getProvider(remoteChain);
      const localDfr = DelayedFlowRouterHookIsm__factory.connect(
        await MailboxClient__factory.connect(
          deployedContracts[chain],
          localProvider,
        ).hook(),
        localProvider,
      );
      const remoteDfr = DelayedFlowRouterHookIsm__factory.connect(
        await MailboxClient__factory.connect(
          deployedContracts[remoteChain],
          remoteProvider,
        ).hook(),
        remoteProvider,
      );

      // mutual DFR enrollment
      const localDomain = multiProvider.getDomainId(chain);
      const remoteDomain = multiProvider.getDomainId(remoteChain);
      expect(await localDfr.routers(remoteDomain)).to.equal(
        addressToBytes32(remoteDfr.address).toLowerCase(),
      );
      expect(await remoteDfr.routers(localDomain)).to.equal(
        addressToBytes32(localDfr.address).toLowerCase(),
      );

      // ownership handed to the configured owner after enrollment
      expect((await localDfr.owner()).toLowerCase()).to.equal(
        warpOwner.toLowerCase(),
      );
      expect((await remoteDfr.owner()).toLowerCase()).to.equal(
        warpOwner.toLowerCase(),
      );

      // a second pass converges to zero transactions
      const secondEnrollTxs = await enrollCrossChainRouters(
        {
          multiProvider,
          altVmSigners: {},
          registryAddresses,
          warpDeployConfig,
        },
        deployedContracts,
      );
      expect(Object.keys(secondEnrollTxs)).to.have.length(0);
    });

    it('reconciles delayedFlowRouterHookIsm enrollment drift', async () => {
      // Owner is the deployer so the drift can be introduced directly and the
      // corrective transactions can be submitted from this test.
      const owner = signer.address;

      const warpDeployConfig: WarpRouteDeployConfigMailboxRequired = {
        [chain]: {
          ...config[chain],
          type: TokenType.synthetic,
          owner,
          interchainSecurityModule: delayedFlowTree(owner),
        },
        [remoteChain]: {
          ...config[remoteChain],
          type: TokenType.synthetic,
          owner,
          interchainSecurityModule: delayedFlowTree(owner),
        },
      };

      const contracts = await deployHybridRoute(
        objMap(warpDeployConfig, (_, c) => ({
          ...c,
          interchainSecurityModule: undefined,
        })),
        {
          [chain]: delayedFlowTree(owner),
          [remoteChain]: delayedFlowTree(owner),
        },
      );
      const deployedContracts = objMap(
        contracts,
        (_, c) => c.synthetic.address,
      );

      const submit = async (txs: ChainMap<TypedAnnotatedTransaction[]>) => {
        for (const [txChain, chainTxs] of Object.entries(txs)) {
          for (const rawTx of chainTxs) {
            assertEvmTransaction(rawTx, txChain);
            await multiProvider.sendTransaction(txChain, {
              to: rawTx.to,
              data: rawTx.data,
              value: rawTx.value,
            });
          }
        }
      };

      await submit(
        await enrollCrossChainRouters(
          {
            multiProvider,
            altVmSigners: {},
            registryAddresses,
            warpDeployConfig,
          },
          deployedContracts,
        ),
      );

      const localProvider = multiProvider.getProvider(chain);
      const localDfrAddress = await MailboxClient__factory.connect(
        deployedContracts[chain],
        localProvider,
      ).hook();
      const localDfr = DelayedFlowRouterHookIsm__factory.connect(
        localDfrAddress,
        multiProvider.getSigner(chain),
      );
      const remoteDomain = multiProvider.getDomainId(remoteChain);

      // Introduce drift: point the local instance at a bogus counterpart.
      const bogusRouter = addressToBytes32(randomAddress()).toLowerCase();
      await multiProvider.handleTx(
        chain,
        localDfr.enrollRemoteRouter(remoteDomain, bogusRouter),
      );
      expect(await localDfr.routers(remoteDomain)).to.equal(bogusRouter);

      // Re-running enrollment must emit corrective transactions...
      const driftTxs = await enrollCrossChainRouters(
        {
          multiProvider,
          altVmSigners: {},
          registryAddresses,
          warpDeployConfig,
        },
        deployedContracts,
      );
      expect(Object.keys(driftTxs)).to.include(chain);
      await submit(driftTxs);

      // ...restoring the real counterpart, and then converging again.
      const remoteDfrAddress = await MailboxClient__factory.connect(
        deployedContracts[remoteChain],
        multiProvider.getProvider(remoteChain),
      ).hook();
      expect(await localDfr.routers(remoteDomain)).to.equal(
        addressToBytes32(remoteDfrAddress).toLowerCase(),
      );

      const convergedTxs = await enrollCrossChainRouters(
        {
          multiProvider,
          altVmSigners: {},
          registryAddresses,
          warpDeployConfig,
        },
        deployedContracts,
      );
      expect(Object.keys(convergedTxs)).to.have.length(0);
    });
  });

  describe('TokenFee with optional token for synthetic', () => {
    it('should deploy LinearFee without token and resolve to router address', async () => {
      const syntheticConfig: WarpRouteDeployConfigMailboxRequired = {
        [chain]: {
          ...config[chain],
          type: TokenType.synthetic,
          tokenFee: {
            type: TokenFeeType.LinearFee,
            owner: signer.address,
            bps: 100,
            maxFee: 1000000000n,
            halfAmount: 500000000n,
          },
        },
      };

      const warpRoute = await deployer.deploy(syntheticConfig);
      const routerAddress = warpRoute[chain].synthetic.address;

      const router = TokenRouter__factory.connect(
        routerAddress,
        multiProvider.getProvider(chain),
      );
      const feeRecipient = await router.feeRecipient();
      expect(isZeroishAddress(feeRecipient)).to.be.false;

      const linearFee = LinearFee__factory.connect(
        feeRecipient,
        multiProvider.getProvider(chain),
      );
      const feeToken = await linearFee.token();
      expect(eqAddress(feeToken, routerAddress)).to.be.true;
    });

    it('should deploy RoutingFee without token and resolve to router address', async () => {
      const syntheticConfig: WarpRouteDeployConfigMailboxRequired = {
        [chain]: {
          ...config[chain],
          type: TokenType.synthetic,
          tokenFee: {
            type: TokenFeeType.RoutingFee,
            owner: signer.address,
            feeContracts: {
              [TestChainName.test2]: {
                type: TokenFeeType.LinearFee,
                owner: signer.address,
                bps: 100,
                maxFee: 1000000000n,
                halfAmount: 500000000n,
              },
            },
          },
        },
      };

      const warpRoute = await deployer.deploy(syntheticConfig);
      const routerAddress = warpRoute[chain].synthetic.address;

      const router = TokenRouter__factory.connect(
        routerAddress,
        multiProvider.getProvider(chain),
      );
      const feeRecipient = await router.feeRecipient();
      expect(isZeroishAddress(feeRecipient)).to.be.false;

      const routingFee = RoutingFee__factory.connect(
        feeRecipient,
        multiProvider.getProvider(chain),
      );
      const feeToken = await routingFee.token();
      expect(eqAddress(feeToken, routerAddress)).to.be.true;
    });

    it('should resolve LinearFee token to the on-chain wrapped token for xERC20Lockbox', async () => {
      // Regression: for a lockbox, tokenConfig.token is the lockbox address, but
      // the router's token()/feeToken() returns the underlying wrapped ERC20.
      // The fee contract must be deployed with token() so the router's
      // "fee must match token" check passes. Resolution reads this on-chain.
      const { name, symbol, decimals } = config[chain];
      assert(name, 'expected a token name in the config');
      assert(symbol, 'expected a token symbol in the config');
      assert(decimals != null, 'expected token decimals in the config');
      const lockbox = await new XERC20LockboxTest__factory(signer).deploy(
        name,
        symbol,
        totalSupply,
        decimals,
      );
      const wrappedToken = await lockbox.ERC20();

      const lockboxConfig: WarpRouteDeployConfigMailboxRequired = {
        [chain]: {
          ...config[chain],
          type: TokenType.XERC20Lockbox,
          token: lockbox.address,
          tokenFee: {
            type: TokenFeeType.LinearFee,
            owner: signer.address,
            bps: 100,
            maxFee: 1000000000n,
            halfAmount: 500000000n,
          },
        },
      };

      const warpRoute = await deployer.deploy(lockboxConfig);
      const routerAddress = warpRoute[chain].xERC20Lockbox.address;

      const router = HypXERC20Lockbox__factory.connect(
        routerAddress,
        multiProvider.getProvider(chain),
      );
      const routerToken = await router.token();
      // Sanity: the router's token is the wrapped ERC20, not the lockbox.
      expect(eqAddress(routerToken, wrappedToken)).to.be.true;
      expect(eqAddress(routerToken, lockbox.address)).to.be.false;

      const feeRecipient = await router.feeRecipient();
      expect(isZeroishAddress(feeRecipient)).to.be.false;

      const linearFee = LinearFee__factory.connect(
        feeRecipient,
        multiProvider.getProvider(chain),
      );
      const feeToken = await linearFee.token();
      // The fee token must equal router.token() (the invariant the router
      // enforces), and must NOT be the lockbox address (the pre-fix bug).
      expect(eqAddress(feeToken, routerToken)).to.be.true;
      expect(eqAddress(feeToken, lockbox.address)).to.be.false;
    });
  });
});
