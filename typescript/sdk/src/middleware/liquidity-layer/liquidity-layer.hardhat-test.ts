import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import { expect } from 'chai';
import hre from 'hardhat';

import {
  LiquidityLayerRouter,
  MockCircleMessageTransmitter,
  MockCircleMessageTransmitter__factory,
  MockCircleTokenMessenger,
  MockCircleTokenMessenger__factory,
  MockToken,
  MockToken__factory,
  TestLiquidityLayerMessageRecipient__factory,
} from '@hyperlane-xyz/core';
import { addressToBytes32, objMap } from '@hyperlane-xyz/utils';

import { TestChainName, test1, test2 } from '../../consts/testChains.js';
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
} from './LiquidityLayerRouterDeployer.js';

// eslint-disable-next-line jest/no-disabled-tests
describe.skip('LiquidityLayerRouter', async () => {
  const localChain = TestChainName.test1;
  const remoteChain = TestChainName.test2;
  const localDomain = test1.domainId!;
  const remoteDomain = test2.domainId!;

  let signer: SignerWithAddress;
  let local: LiquidityLayerRouter;
  let multiProvider: MultiProvider;
  let coreApp: TestCoreApp;

  let liquidityLayerApp: LiquidityLayerApp;
  let config: ChainMap<LiquidityLayerConfig>;
  let mockToken: MockToken;
  let circleTokenMessenger: MockCircleTokenMessenger;
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
    const circleTokenMessengerF = new MockCircleTokenMessenger__factory(signer);
    circleTokenMessenger = await circleTokenMessengerF.deploy(
      mockToken.address,
    );
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
});
