import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

import {
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
import { HypTokenRouterConfig, WarpRouteDeployConfig } from './types.js';

const chain = TestChainName.test1;

describe('TokenDeployer', async () => {
  let signer: SignerWithAddress;
  let deployer: HypERC20Deployer;
  let multiProvider: MultiProvider;
  let coreApp: TestCoreApp;
  let config: WarpRouteDeployConfig;
  let token: Address;
  let xerc20: XERC20Test;
  let admin: ProxyAdmin;

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
    config = objMap(
      routerConfigMap,
      (chain, c): HypTokenRouterConfig => ({
        type: TokenType.synthetic,
        name: chain,
        symbol: `u${chain}`,
        decimals: 18,
        totalSupply: '100000',
        ...c,
      }),
    );
  });

  beforeEach(async () => {
    const { name, decimals, symbol, totalSupply } = config[chain];
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
    describe('HypERC20Checker', async () => {
      let checker: HypERC20Checker;

      beforeEach(async () => {
        config[chain] = {
          ...config[chain],
          type,
          // @ts-ignore
          token:
            type === TokenType.XERC20 || type === TokenType.collateral
              ? token
              : undefined,
        };
        const contractsMap = await deployer.deploy(config);
        const app = new HypERC20App(contractsMap, multiProvider);
        checker = new HypERC20Checker(multiProvider, app, config);
      });

      it(`should have no violations on clean deploy of ${type}`, async () => {
        await checker.check();
        console.log(checker.violations);
        checker.expectEmpty();
      });

      it(`should check owner of collateral`, async () => {
        if (type !== TokenType.XERC20) {
          return;
        }

        await xerc20.transferOwnership(ethers.Wallet.createRandom().address);
        await checker.check();
        checker.expectViolations({
          [ViolationType.Owner]: 1,
        });
      });

      it(`should check owner of collateral proxyAdmin`, async () => {
        if (type !== TokenType.XERC20) {
          return;
        }

        await admin.transferOwnership(ethers.Wallet.createRandom().address);
        await checker.check();
        checker.expectViolations({
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
          token:
            type === TokenType.XERC20 || type === TokenType.collateral
              ? token
              : undefined,
        };
        const warpRoute = await deployer.deploy(config);
        routerAddress = warpRoute[chain][type].address;
      });

      it(`should derive HypTokenRouterConfig correctly`, async () => {
        // reader does not support XERC20
        if (type === TokenType.XERC20) {
          return;
        }

        const derivedConfig = await reader.deriveWarpRouteConfig(routerAddress);
        expect(derivedConfig.type).to.equal(config[chain].type);
      });
    });
  }
});
