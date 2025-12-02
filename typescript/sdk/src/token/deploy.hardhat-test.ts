import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

import {
  ERC20Test,
  ERC20Test__factory,
  ProxyAdmin,
  ProxyAdmin__factory,
  TransparentUpgradeableProxy__factory,
  XERC20Test,
  XERC20Test__factory,
} from '@hyperlane-xyz/core';
import { Address, objMap } from '@hyperlane-xyz/utils';

import { TestChainName } from '../consts/testChains.js';
import { TestCoreApp } from '../core/TestCoreApp.js';
import { TestCoreDeployer } from '../core/TestCoreDeployer.js';
import { HyperlaneProxyFactoryDeployer } from '../deploy/HyperlaneProxyFactoryDeployer.js';
import { ViolationType } from '../deploy/types.js';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
import { MultiProvider } from '../providers/MultiProvider.js';

import { EvmERC20WarpRouteReader } from './EvmERC20WarpRouteReader.js';
import { HypERC20App } from './app.js';
import { HypERC20Checker } from './checker.js';
import { TokenType } from './config.js';
import { HypERC20Deployer } from './deploy.js';
import {
  SyntheticTokenConfig,
  WarpRouteDeployConfigMailboxRequired,
} from './types.js';

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
          // @ts-ignore
          token: token(),
        };

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
      let reader: EvmERC20WarpRouteReader;
      let routerAddress: Address;

      before(() => {
        reader = new EvmERC20WarpRouteReader(
          multiProvider,
          TestChainName.test1,
        );
      });

      beforeEach(async () => {
        config[chain] = {
          ...config[chain],
          type,
          // @ts-ignore
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
});
