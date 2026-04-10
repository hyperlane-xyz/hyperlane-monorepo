import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

import {
  ERC20Test,
  ERC20Test__factory,
  GasRouter__factory,
  LinearFee__factory,
  ProxyAdmin,
  ProxyAdmin__factory,
  RoutingFee__factory,
  TokenRouter__factory,
  TransparentUpgradeableProxy__factory,
  XERC20Test,
  XERC20Test__factory,
} from '@hyperlane-xyz/core';
import {
  Address,
  ProtocolType,
  deepCopy,
  eqAddress,
  isZeroishAddress,
  objMap,
} from '@hyperlane-xyz/utils';

import { TestChainName } from '../consts/testChains.js';
import { TestCoreApp } from '../core/TestCoreApp.js';
import { TestCoreDeployer } from '../core/TestCoreDeployer.js';
import { HyperlaneProxyFactoryDeployer } from '../deploy/HyperlaneProxyFactoryDeployer.js';
import { TokenFeeType } from '../fee/types.js';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
import { MultiProvider } from '../providers/MultiProvider.js';

import { EvmWarpRouteReader } from './EvmWarpRouteReader.js';
import { TokenType } from './config.js';
import { checkWarpRouteDeployConfig } from './warpCheck.js';
import { HypERC20Deployer } from './deploy.js';
import {
  SyntheticTokenConfig,
  WarpRouteDeployConfigMailboxRequired,
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
            'Warp route check requires at least one EVM chain in the selected route config',
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
  });
});
