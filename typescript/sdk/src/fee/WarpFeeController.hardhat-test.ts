import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import { expect } from 'chai';
import hre from 'hardhat';

import {
  ERC20Test,
  ERC20Test__factory,
  HypERC20Collateral__factory,
  HypNative__factory,
  ITokenBridge__factory,
  MockWarpFeeRemoteBridge__factory,
  MockWarpFeeControllerIcaRouter,
  MockWarpFeeControllerIcaRouter__factory,
  RoutingFee__factory,
  TokenRouter__factory,
} from '@hyperlane-xyz/core';
import {
  addressToBytes32,
  bytes32ToAddress,
  eqAddress,
} from '@hyperlane-xyz/utils';

import { TestCoreApp } from '../core/TestCoreApp.js';
import { TestCoreDeployer } from '../core/TestCoreDeployer.js';
import { HyperlaneProxyFactoryDeployer } from '../deploy/HyperlaneProxyFactoryDeployer.js';
import { ProxyFactoryFactories } from '../deploy/contracts.js';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { TestChainName } from '../consts/testChains.js';
import { serializeContracts } from '../contracts/contracts.js';
import { HyperlaneAddresses } from '../contracts/types.js';
import { EvmWarpModule } from '../token/EvmWarpModule.js';
import { TokenType } from '../token/config.js';
import { HypTokenRouterConfig } from '../token/types.js';

import { EvmTokenFeeModule } from './EvmTokenFeeModule.js';
import { EvmWarpFeeControllerModule } from './WarpFeeController.js';
import { TokenFeeType } from './types.js';

describe('EvmWarpFeeControllerModule', () => {
  const chain = TestChainName.test4;
  const remoteDomain = 12_345;
  const amount = 1_000;
  const paymentAmount = 1_100;
  const lpBps = 2_500;

  let signer: SignerWithAddress;
  let feeManager: SignerWithAddress;
  let protocolBeneficiary: SignerWithAddress;
  let multiProvider: MultiProvider;
  let proxyFactoryFactories: HyperlaneAddresses<ProxyFactoryFactories>;
  let coreApp: TestCoreApp;
  let icaRouter: MockWarpFeeControllerIcaRouter;
  let token: ERC20Test;

  before(async () => {
    [signer, feeManager, protocolBeneficiary] = await hre.ethers.getSigners();
    multiProvider = MultiProvider.createTestMultiProvider({ signer });

    const proxyFactories = await new HyperlaneProxyFactoryDeployer(
      multiProvider,
    ).deploy(multiProvider.mapKnownChains(() => ({})));
    proxyFactoryFactories = serializeContracts(proxyFactories[chain]);

    const ismFactory = new HyperlaneIsmFactory(proxyFactories, multiProvider);
    coreApp = await new TestCoreDeployer(multiProvider, ismFactory).deployApp();

    icaRouter = await new MockWarpFeeControllerIcaRouter__factory(
      signer,
    ).deploy();

    token = await new ERC20Test__factory(signer).deploy(
      'Test Token',
      'TST',
      '100000000000000000000',
      18,
    );
  });

  it('deploys warp, fee, and controller modules; governs/claims/distributes through the ICA-routed path', async () => {
    const remoteIca = await icaRouter.remoteIca();
    const baseConfig = coreApp.getRouterConfig(signer.address)[chain];
    const warpConfig: HypTokenRouterConfig = {
      ...baseConfig,
      type: TokenType.collateral,
      token: token.address,
      tokenFee: {
        type: TokenFeeType.RoutingFee,
        owner: remoteIca,
        feeContracts: {
          [chain]: {
            type: TokenFeeType.LinearFee,
            owner: remoteIca,
            bps: 100,
          },
        },
      },
    };
    const warpModule = await EvmWarpModule.create({
      chain,
      multiProvider,
      proxyFactoryFactories,
      config: warpConfig,
    });
    for (const tx of await warpModule.update(warpConfig)) {
      await multiProvider.sendTransaction(chain, tx);
    }

    const hubRouterAddress = warpModule.serialize().deployedTokenRoute;
    const hubRouter = HypERC20Collateral__factory.connect(
      hubRouterAddress,
      signer,
    );
    const routingFeeAddress = await TokenRouter__factory.connect(
      hubRouterAddress,
      signer,
    ).feeRecipient();
    const routingFee = RoutingFee__factory.connect(routingFeeAddress, signer);

    expect(eqAddress(await routingFee.owner(), remoteIca)).to.be.true;

    const controller = await EvmWarpFeeControllerModule.create({
      multiProvider,
      chain,
      config: {
        owner: signer.address,
        interchainAccountRouter: icaRouter.address,
        hubDomain: multiProvider.getDomainId(chain),
        hubRouter: hubRouterAddress,
        lpBps,
        protocolBeneficiary: protocolBeneficiary.address,
        feeManager: feeManager.address,
      },
    });
    expect((await controller.read()).hubRouter).to.equal(hubRouterAddress);
    const feeManagerController = new EvmWarpFeeControllerModule(
      multiProvider,
      chain,
      controller.contract.connect(feeManager),
    );

    const newFee = await EvmTokenFeeModule.create({
      multiProvider,
      chain,
      config: {
        type: TokenFeeType.LinearFee,
        token: token.address,
        owner: remoteIca,
        maxFee: 1_000n,
        halfAmount: 5_000n,
        bps: 1_000,
      },
    });
    const newFeeAddress = newFee.serialize().deployedFee;
    expect(await routingFee.feeContracts(remoteDomain)).to.not.equal(
      newFeeAddress,
    );

    const feeUpdateCall = EvmWarpFeeControllerModule.buildRoutingFeeUpdateCall({
      routingFee: routingFeeAddress,
      destination: remoteDomain,
      feeContract: newFeeAddress,
    });
    await feeManagerController.dispatchFeeUpdate({
      remoteDomain,
      calls: [feeUpdateCall],
    });

    expect(await icaRouter.lastDestination()).to.equal(remoteDomain);
    expect(await icaRouter.lastCallsLength()).to.equal(1);
    expect(await routingFee.feeContracts(remoteDomain)).to.equal(newFeeAddress);
    const [feeUpdateTarget, feeUpdateValue, feeUpdateData] =
      await icaRouter.getLastCall(0);
    expect(bytes32ToAddress(feeUpdateTarget)).to.equal(routingFeeAddress);
    expect(feeUpdateValue).to.equal(0);
    expect(feeUpdateData).to.equal(feeUpdateCall.data);

    const remoteBridge = await new MockWarpFeeRemoteBridge__factory(
      signer,
    ).deploy(token.address);
    await token.mintTo(routingFeeAddress, paymentAmount);
    expect(await token.balanceOf(routingFeeAddress)).to.equal(paymentAmount);
    expect(await token.balanceOf(remoteIca)).to.equal(0);
    expect(await token.balanceOf(controller.contract.address)).to.equal(0);

    await controller.collect({
      remoteDomain,
      feeContract: routingFeeAddress,
      token: token.address,
      remoteRouter: remoteBridge.address,
      amount,
      paymentAmount,
    });

    expect(await icaRouter.lastCallsLength()).to.equal(5);
    const [claimTarget] = await icaRouter.getLastCall(0);
    expect(bytes32ToAddress(claimTarget)).to.equal(routingFeeAddress);

    const [transferTarget, transferValue, transferData] =
      await icaRouter.getLastCall(3);
    expect(bytes32ToAddress(transferTarget)).to.equal(remoteBridge.address);
    expect(transferValue).to.equal(0);
    expect(transferData).to.equal(
      ITokenBridge__factory.createInterface().encodeFunctionData(
        'transferRemote(uint32,bytes32,uint256)',
        [
          multiProvider.getDomainId(chain),
          addressToBytes32(controller.contract.address),
          amount,
        ],
      ),
    );
    expect(await token.balanceOf(routingFeeAddress)).to.equal(0);
    expect(await token.balanceOf(remoteIca)).to.equal(paymentAmount - amount);
    expect(await token.balanceOf(controller.contract.address)).to.equal(amount);
    expect(await token.allowance(remoteIca, remoteBridge.address)).to.equal(0);
    expect(await remoteBridge.lastDestination()).to.equal(
      multiProvider.getDomainId(chain),
    );
    expect(await remoteBridge.lastRecipient()).to.equal(
      addressToBytes32(controller.contract.address),
    );
    expect(await remoteBridge.lastAmount()).to.equal(amount);

    const lpDonation = (amount * lpBps) / 10_000;
    const totalAssetsBefore = await hubRouter.totalAssets();
    const protocolBalanceBefore = await token.balanceOf(
      protocolBeneficiary.address,
    );
    await controller.distribute(token.address);

    expect(await hubRouter.totalAssets()).to.equal(
      totalAssetsBefore.add(lpDonation),
    );
    expect(await token.balanceOf(protocolBeneficiary.address)).to.equal(
      protocolBalanceBefore.add(amount - lpDonation),
    );
    expect(await token.balanceOf(controller.contract.address)).to.equal(0);
  });

  it('claims and distributes native fees through the ICA-routed path', async () => {
    const remoteIca = await icaRouter.remoteIca();
    const nativeToken = hre.ethers.constants.AddressZero;
    const baseConfig = coreApp.getRouterConfig(signer.address)[chain];
    const warpConfig: HypTokenRouterConfig = {
      ...baseConfig,
      type: TokenType.native,
      tokenFee: {
        type: TokenFeeType.RoutingFee,
        owner: remoteIca,
        feeContracts: {
          [chain]: {
            type: TokenFeeType.LinearFee,
            owner: remoteIca,
            bps: 100,
          },
        },
      },
    };
    const warpModule = await EvmWarpModule.create({
      chain,
      multiProvider,
      proxyFactoryFactories,
      config: warpConfig,
    });
    for (const tx of await warpModule.update(warpConfig)) {
      await multiProvider.sendTransaction(chain, tx);
    }

    const hubRouterAddress = warpModule.serialize().deployedTokenRoute;
    const hubRouter = HypNative__factory.connect(hubRouterAddress, signer);
    const routingFeeAddress = await TokenRouter__factory.connect(
      hubRouterAddress,
      signer,
    ).feeRecipient();
    const routingFee = RoutingFee__factory.connect(routingFeeAddress, signer);

    expect(eqAddress(await routingFee.owner(), remoteIca)).to.be.true;
    expect(await routingFee.token()).to.equal(nativeToken);

    const controller = await EvmWarpFeeControllerModule.create({
      multiProvider,
      chain,
      config: {
        owner: signer.address,
        interchainAccountRouter: icaRouter.address,
        hubDomain: multiProvider.getDomainId(chain),
        hubRouter: hubRouterAddress,
        lpBps,
        protocolBeneficiary: protocolBeneficiary.address,
        feeManager: feeManager.address,
      },
    });

    const remoteBridge = await new MockWarpFeeRemoteBridge__factory(
      signer,
    ).deploy(nativeToken);
    await signer.sendTransaction({
      to: routingFeeAddress,
      value: paymentAmount,
    });
    expect(await hre.ethers.provider.getBalance(routingFeeAddress)).to.equal(
      paymentAmount,
    );
    expect(await hre.ethers.provider.getBalance(remoteIca)).to.equal(0);
    expect(
      await hre.ethers.provider.getBalance(controller.contract.address),
    ).to.equal(0);

    await controller.collect({
      remoteDomain,
      feeContract: routingFeeAddress,
      token: nativeToken,
      remoteRouter: remoteBridge.address,
      amount,
      paymentAmount,
    });

    expect(await icaRouter.lastCallsLength()).to.equal(2);
    const [claimTarget] = await icaRouter.getLastCall(0);
    expect(bytes32ToAddress(claimTarget)).to.equal(routingFeeAddress);

    const [transferTarget, transferValue, transferData] =
      await icaRouter.getLastCall(1);
    expect(bytes32ToAddress(transferTarget)).to.equal(remoteBridge.address);
    expect(transferValue).to.equal(paymentAmount);
    expect(transferData).to.equal(
      ITokenBridge__factory.createInterface().encodeFunctionData(
        'transferRemote(uint32,bytes32,uint256)',
        [
          multiProvider.getDomainId(chain),
          addressToBytes32(controller.contract.address),
          amount,
        ],
      ),
    );
    expect(await hre.ethers.provider.getBalance(routingFeeAddress)).to.equal(0);
    expect(await hre.ethers.provider.getBalance(remoteIca)).to.equal(0);
    expect(await hre.ethers.provider.getBalance(remoteBridge.address)).to.equal(
      paymentAmount - amount,
    );
    expect(
      await hre.ethers.provider.getBalance(controller.contract.address),
    ).to.equal(amount);
    expect(await remoteBridge.lastDestination()).to.equal(
      multiProvider.getDomainId(chain),
    );
    expect(await remoteBridge.lastRecipient()).to.equal(
      addressToBytes32(controller.contract.address),
    );
    expect(await remoteBridge.lastAmount()).to.equal(amount);

    const lpDonation = (amount * lpBps) / 10_000;
    const totalAssetsBefore = await hubRouter.totalAssets();
    const protocolBalanceBefore = await hre.ethers.provider.getBalance(
      protocolBeneficiary.address,
    );
    await controller.distribute(nativeToken);

    expect(await hubRouter.totalAssets()).to.equal(
      totalAssetsBefore.add(lpDonation),
    );
    expect(
      await hre.ethers.provider.getBalance(protocolBeneficiary.address),
    ).to.equal(protocolBalanceBefore.add(amount - lpDonation));
    expect(
      await hre.ethers.provider.getBalance(controller.contract.address),
    ).to.equal(0);
  });
});
