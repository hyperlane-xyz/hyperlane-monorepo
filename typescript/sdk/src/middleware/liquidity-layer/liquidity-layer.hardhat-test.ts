import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import { expect } from 'chai';
import hre from 'hardhat';

import {
  LiquidityLayerRouter,
  MockCircleMessageTransmitter,
  MockCircleMessageTransmitter__factory,
  MockCircleTokenMessenger,
  MockCircleTokenMessenger__factory,
  MockPortalBridge,
  MockPortalBridge__factory,
  MockToken,
  MockToken__factory,
  TestLiquidityLayerMessageRecipient__factory,
} from '@hyperlane-xyz/core';
import { addressToBytes32, objMap } from '@hyperlane-xyz/utils';

import { chainMetadata } from '../../consts/chainMetadata.js';
import { Chains } from '../../consts/chains.js';
import { TestCoreApp } from '../../core/TestCoreApp.js';
import { TestCoreDeployer } from '../../core/TestCoreDeployer.js';
import { HyperlaneProxyFactoryDeployer } from '../../deploy/HyperlaneProxyFactoryDeployer.js';
import { HyperlaneIsmFactory } from '../../ism/HyperlaneIsmFactory.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { ChainMap } from '../../types.js';

import { LiquidityLayerApp } from './LiquidityLayerApp.js';
import {
  BridgeAdapterType,
  CircleBridgeAdapterConfig,
  LiquidityLayerConfig,
  LiquidityLayerDeployer,
  PortalAdapterConfig,
} from './LiquidityLayerRouterDeployer.js';

describe.skip('LiquidityLayerRouter', async () => {
  const localChain = Chains.test1;
  const remoteChain = Chains.test2;
  const localDomain = chainMetadata[localChain].chainId;
  const remoteDomain = chainMetadata[remoteChain].chainId;

  let signer: SignerWithAddress;
  let local: LiquidityLayerRouter;
  let multiProvider: MultiProvider;
  let coreApp: TestCoreApp;

  let liquidityLayerApp: LiquidityLayerApp;
  let config: ChainMap<LiquidityLayerConfig>;
  let mockToken: MockToken;
  let circleTokenMessenger: MockCircleTokenMessenger;
  let portalBridge: MockPortalBridge;
  let messageTransmitter: MockCircleMessageTransmitter;

  before(async () => {
    [signer] = await hre.ethers.getSigners();
    multiProvider = MultiProvider.createTestMultiProvider({ signer });
    const ismFactoryDeployer = new HyperlaneProxyFactoryDeployer(multiProvider);
    const ismFactory = new HyperlaneIsmFactory(
      await ismFactoryDeployer.deploy(multiProvider.mapKnownChains(() => ({}))),
      multiProvider,
    );
    coreApp = await new TestCoreDeployer(multiProvider, ismFactory).deployApp();
    const routerConfig = coreApp.getRouterConfig(signer.address);

    const mockTokenF = new MockToken__factory(signer);
    mockToken = await mockTokenF.deploy();
    const portalBridgeF = new MockPortalBridge__factory(signer);
    const circleTokenMessengerF = new MockCircleTokenMessenger__factory(signer);
    circleTokenMessenger = await circleTokenMessengerF.deploy(
      mockToken.address,
    );
    portalBridge = await portalBridgeF.deploy(mockToken.address);
    const messageTransmitterF = new MockCircleMessageTransmitter__factory(
      signer,
    );
    messageTransmitter = await messageTransmitterF.deploy(mockToken.address);

    config = objMap(routerConfig, (chain, config) => {
      return {
        ...config,
        circle: {
          type: BridgeAdapterType.Circle,
          tokenMessengerAddress: circleTokenMessenger.address,
          messageTransmitterAddress: messageTransmitter.address,
          usdcAddress: mockToken.address,
          circleDomainMapping: [
            {
              hyperlaneDomain: localDomain,
              circleDomain: localDomain,
            },
            {
              hyperlaneDomain: remoteDomain,
              circleDomain: remoteDomain,
            },
          ],
        } as CircleBridgeAdapterConfig,
        portal: {
          type: BridgeAdapterType.Portal,
          portalBridgeAddress: portalBridge.address,
          wormholeDomainMapping: [
            {
              hyperlaneDomain: localDomain,
              wormholeDomain: localDomain,
            },
            {
              hyperlaneDomain: remoteDomain,
              wormholeDomain: remoteDomain,
            },
          ],
        } as PortalAdapterConfig,
      };
    });
  });

  beforeEach(async () => {
    const LiquidityLayer = new LiquidityLayerDeployer(multiProvider);
    const contracts = await LiquidityLayer.deploy(config);

    liquidityLayerApp = new LiquidityLayerApp(contracts, multiProvider, config);

    local = liquidityLayerApp.getContracts(localChain).liquidityLayerRouter;
  });

  it('can transfer tokens via Circle', async () => {
    const recipientF = new TestLiquidityLayerMessageRecipient__factory(signer);
    const recipient = await recipientF.deploy();

    const amount = 1000;
    await mockToken.mint(signer.address, amount);
    await mockToken.approve(local.address, amount);
    await local.dispatchWithTokens(
      remoteDomain,
      addressToBytes32(recipient.address),
      mockToken.address,
      amount,
      BridgeAdapterType.Circle,
      '0x01',
    );

    const transferNonce = await circleTokenMessenger.nextNonce();
    const nonceId = await messageTransmitter.hashSourceAndNonce(
      localDomain,
      transferNonce,
    );

    await messageTransmitter.process(
      nonceId,
      liquidityLayerApp.getContracts(remoteChain).circleBridgeAdapter!.address,
      amount,
    );
    await coreApp.processMessages();

    expect((await mockToken.balanceOf(recipient.address)).toNumber()).to.eql(
      amount,
    );
  });

  it('can transfer tokens via Portal', async () => {
    const recipientF = new TestLiquidityLayerMessageRecipient__factory(signer);
    const recipient = await recipientF.deploy();

    const amount = 1000;
    await mockToken.mint(signer.address, amount);
    await mockToken.approve(local.address, amount);
    await local.dispatchWithTokens(
      remoteDomain,
      addressToBytes32(recipient.address),
      mockToken.address,
      amount,
      BridgeAdapterType.Portal,
      '0x01',
    );

    const originAdapter =
      liquidityLayerApp.getContracts(localChain).portalAdapter!;
    const destinationAdapter =
      liquidityLayerApp.getContracts(remoteChain).portalAdapter!;
    await destinationAdapter.completeTransfer(
      await portalBridge.mockPortalVaa(
        localDomain,
        await originAdapter.nonce(),
        amount,
      ),
    );
    await coreApp.processMessages();

    expect((await mockToken.balanceOf(recipient.address)).toNumber()).to.eql(
      amount,
    );
  });
});
