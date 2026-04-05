import { readFileSync } from 'fs';

import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

import {
  ERC20Test,
  ERC20Test__factory,
  ERC4626Test__factory,
  LinearFee__factory,
  ProxyAdmin,
  ProxyAdmin__factory,
  RoutingFee__factory,
  TokenBridgeKatanaRedeemIca__factory,
  TokenBridgeKatanaVaultHelper__factory,
  TokenBridgeOft__factory,
  TokenRouter__factory,
  TransparentUpgradeableProxy__factory,
  XERC20Test,
  XERC20Test__factory,
} from '@hyperlane-xyz/core';
import {
  Address,
  eqAddress,
  isZeroishAddress,
  objMap,
} from '@hyperlane-xyz/utils';

import { TestChainName } from '../consts/testChains.js';
import { TestCoreApp } from '../core/TestCoreApp.js';
import { TestCoreDeployer } from '../core/TestCoreDeployer.js';
import { HyperlaneProxyFactoryDeployer } from '../deploy/HyperlaneProxyFactoryDeployer.js';
import { ViolationType } from '../deploy/types.js';
import { TokenFeeType } from '../fee/types.js';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
import { MultiProvider } from '../providers/MultiProvider.js';

import { EvmWarpRouteReader } from './EvmWarpRouteReader.js';
import { HypERC20App } from './app.js';
import { HypERC20Checker } from './checker.js';
import { TokenType } from './config.js';
import { HypERC20Deployer } from './deploy.js';
import {
  SyntheticTokenConfig,
  WarpRouteDeployConfigMailboxRequired,
  isDepositAddressTokenConfig,
} from './types.js';

const chain = TestChainName.test1;
const MOCK_COMPOSE_OFT_ARTIFACT = JSON.parse(
  readFileSync(
    new URL(
      '../../../../solidity/out/TokenBridgeKatanaVault.t.sol/MockComposeOFT.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const MOCK_WETH_ARTIFACT = JSON.parse(
  readFileSync(
    new URL(
      '../../../../solidity/out/TokenBridgeKatanaVault.t.sol/MockWETH.json',
      import.meta.url,
    ),
    'utf8',
  ),
);

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

  async function deployMockComposeOft(tokenAddress: Address) {
    return new ethers.ContractFactory(
      MOCK_COMPOSE_OFT_ARTIFACT.abi,
      MOCK_COMPOSE_OFT_ARTIFACT.bytecode.object,
      signer,
    ).deploy(tokenAddress, true, 6);
  }

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

  it('deploys a katana vault helper from YAML-only config', async () => {
    const asset = await new ERC20Test__factory(signer).deploy(
      'USD Coin',
      'USDC',
      totalSupply,
      6,
    );
    const vault = await new ERC4626Test__factory(signer).deploy(
      asset.address,
      'Vaulted USDC',
      'vbUSDC',
    );
    const composeOft = await deployMockComposeOft(vault.address);
    const shareBridge = await new TokenBridgeOft__factory(signer).deploy(
      composeOft.address,
      signer.address,
    );
    const katanaBeneficiary = ethers.utils.hexZeroPad(
      ethers.Wallet.createRandom().address,
      32,
    );
    const ethereumBeneficiary = ethers.Wallet.createRandom().address;

    const helperConfig: WarpRouteDeployConfigMailboxRequired = {
      [chain]: {
        owner: config[chain].owner,
        mailbox: config[chain].mailbox,
        type: TokenType.collateralKatanaVaultHelper,
        shareVault: vault.address,
        shareBridge: shareBridge.address,
        katanaBeneficiary,
        ethereumBeneficiary,
      },
    };

    const contracts = await deployer.deploy(helperConfig);
    const helper = TokenBridgeKatanaVaultHelper__factory.connect(
      contracts[chain][TokenType.collateralKatanaVaultHelper].address,
      signer,
    );

    expect(await helper.shareVault()).to.equal(vault.address);
    expect(await helper.shareBridge()).to.equal(shareBridge.address);
    expect(await helper.katanaBeneficiary()).to.equal(
      katanaBeneficiary.toLowerCase(),
    );
    expect(await helper.ethereumBeneficiary()).to.equal(ethereumBeneficiary);
    expect(await helper.token()).to.equal(asset.address);
  });

  it('derives native metadata for katana vault helper configs', async () => {
    const nativeToken = multiProvider.getChainMetadata(chain).nativeToken;
    expect(nativeToken).to.not.equal(undefined);

    const weth = await new ethers.ContractFactory(
      MOCK_WETH_ARTIFACT.abi,
      MOCK_WETH_ARTIFACT.bytecode.object,
      signer,
    ).deploy();
    const vault = await new ERC4626Test__factory(signer).deploy(
      weth.address,
      'Vaulted Ether',
      'vbETH',
    );

    const metadata = await HypERC20Deployer.deriveTokenMetadata(multiProvider, {
      [chain]: {
        owner: config[chain].owner,
        mailbox: config[chain].mailbox,
        type: TokenType.nativeKatanaVaultHelper,
        shareVault: vault.address,
        shareBridge: ethers.Wallet.createRandom().address,
        katanaBeneficiary: ethers.utils.hexZeroPad(
          ethers.Wallet.createRandom().address,
          32,
        ),
        ethereumBeneficiary: ethers.Wallet.createRandom().address,
        wrappedNativeToken: weth.address,
      },
    });

    expect(metadata.getName(chain)).to.equal(nativeToken!.name);
    expect(metadata.getSymbol(chain)).to.equal(nativeToken!.symbol);
    expect(metadata.getDecimals(chain)).to.equal(nativeToken!.decimals);
  });

  it('deploys a native katana vault helper from YAML-only config', async () => {
    const weth = await new ethers.ContractFactory(
      MOCK_WETH_ARTIFACT.abi,
      MOCK_WETH_ARTIFACT.bytecode.object,
      signer,
    ).deploy();
    const vault = await new ERC4626Test__factory(signer).deploy(
      weth.address,
      'Vaulted Ether',
      'vbETH',
    );
    const composeOft = await deployMockComposeOft(vault.address);
    const shareBridge = await new TokenBridgeOft__factory(signer).deploy(
      composeOft.address,
      signer.address,
    );
    const katanaBeneficiary = ethers.utils.hexZeroPad(
      ethers.Wallet.createRandom().address,
      32,
    );
    const ethereumBeneficiary = ethers.Wallet.createRandom().address;

    const helperConfig: WarpRouteDeployConfigMailboxRequired = {
      [chain]: {
        owner: config[chain].owner,
        mailbox: config[chain].mailbox,
        type: TokenType.nativeKatanaVaultHelper,
        shareVault: vault.address,
        shareBridge: shareBridge.address,
        katanaBeneficiary,
        ethereumBeneficiary,
        wrappedNativeToken: weth.address,
      },
    };

    const contracts = await deployer.deploy(helperConfig);
    const helper = TokenBridgeKatanaVaultHelper__factory.connect(
      contracts[chain][TokenType.nativeKatanaVaultHelper].address,
      signer,
    );

    expect(await helper.wrappedNativeToken()).to.equal(weth.address);
    expect(await helper.token()).to.equal(ethers.constants.AddressZero);
  });

  it('deploys a katana redeem ICA bridge from YAML-only config', async () => {
    const asset = await new ERC20Test__factory(signer).deploy(
      'Vaulted Bitcoin',
      'WBTC',
      totalSupply,
      8,
    );
    const vault = await new ERC4626Test__factory(signer).deploy(
      asset.address,
      'Vaulted Bitcoin',
      'vbWBTC',
    );
    const composeOft = await deployMockComposeOft(vault.address);
    const shareBridge = await new TokenBridgeOft__factory(signer).deploy(
      composeOft.address,
      signer.address,
    );
    const icaRouter = ethers.Wallet.createRandom().address;
    const ethereumVaultHelper = ethers.Wallet.createRandom().address;
    const ethereumBeneficiary = ethers.Wallet.createRandom().address;

    const redeemConfig: WarpRouteDeployConfigMailboxRequired = {
      [chain]: {
        owner: config[chain].owner,
        mailbox: config[chain].mailbox,
        type: TokenType.collateralKatanaRedeemIca,
        shareBridge: shareBridge.address,
        icaRouter,
        ethereumVaultHelper,
        ethereumBeneficiary,
        redeemGasLimit: 250000,
      },
    };

    const contracts = await deployer.deploy(redeemConfig);
    const redeemBridge = TokenBridgeKatanaRedeemIca__factory.connect(
      contracts[chain][TokenType.collateralKatanaRedeemIca].address,
      signer,
    );

    expect(await redeemBridge.shareBridge()).to.equal(shareBridge.address);
    expect(await redeemBridge.icaRouter()).to.equal(icaRouter);
    expect(await redeemBridge.ethereumVaultHelper()).to.equal(
      ethereumVaultHelper,
    );
    expect(await redeemBridge.ethereumBeneficiary()).to.equal(
      ethereumBeneficiary,
    );
    expect(await redeemBridge.redeemGasLimit()).to.equal(250000);
    expect(await redeemBridge.token()).to.equal(vault.address);
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

    describe('HypERC20Checker', async () => {
      let checker: HypERC20Checker;
      let app: HypERC20App;
      beforeEach(async () => {
        config[chain] = {
          ...config[chain],
          type,
          token: token(),
        } as any;

        const contractsMap = await deployer.deploy(config);
        app = new HypERC20App(contractsMap, multiProvider);
        checker = new HypERC20Checker(multiProvider, app, config);
      });

      it(`should have no violations on clean deploy of ${type}`, async () => {
        await checker.check();
        checker.expectEmpty();
      });

      it(`should not output "collateralToken" violation when ownerOverrides is unset`, async () => {
        if (type !== TokenType.XERC20) {
          return;
        }

        await xerc20.transferOwnership(ethers.Wallet.createRandom().address);
        await checker.check();
        checker.expectViolations({
          [ViolationType.Owner]: 0, // No violation because ownerOverrides is not set
        });
      });

      it('should output "collateralToken" violation when ownerOverrides.collateralToken is set', async () => {
        if (type !== TokenType.XERC20) {
          return;
        }
        const previousOwner = await xerc20.owner();
        const configWithOverrides = addOverridesToConfig(config, {
          collateralToken: previousOwner,
        });

        const checkerWithOwnerOverrides = new HypERC20Checker(
          multiProvider,
          app,
          configWithOverrides,
        );

        await xerc20.transferOwnership(ethers.Wallet.createRandom().address);
        await checkerWithOwnerOverrides.check();
        checkerWithOwnerOverrides.expectViolations({
          [ViolationType.Owner]: 1,
        });
      });

      it(`should not output "collateralProxyAdmin" violation when ownerOverrides is unset`, async () => {
        if (type !== TokenType.XERC20) {
          return;
        }

        await admin.transferOwnership(ethers.Wallet.createRandom().address);
        await checker.check();
        checker.expectViolations({
          [ViolationType.Owner]: 0, // No violation because ownerOverrides is not set
        });
      });

      it('should output "collateralProxyAdmin" violation when ownerOverrides.collateralProxyAdmin is set', async () => {
        if (type !== TokenType.XERC20) {
          return;
        }
        const previousOwner = await admin.owner();
        const configWithOverrides = addOverridesToConfig(config, {
          collateralProxyAdmin: previousOwner,
        });
        const checkerWithOwnerOverrides = new HypERC20Checker(
          multiProvider,
          app,
          configWithOverrides,
        );

        await admin.transferOwnership(ethers.Wallet.createRandom().address);
        await checkerWithOwnerOverrides.check();
        checkerWithOwnerOverrides.expectViolations({
          [ViolationType.Owner]: 1,
        });
      });
    });

    describe('ERC20WarpRouterReader', async () => {
      let reader: EvmWarpRouteReader;
      let routerAddress: Address;

      before(() => {
        reader = new EvmWarpRouteReader(multiProvider, TestChainName.test1);
      });

      beforeEach(async () => {
        config[chain] = {
          ...config[chain],
          type,
          token: token(),
        } as any;
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
            bps: 100n,
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
                bps: 100n,
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
