import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import {
  ChainMap,
  Chains,
  HyperlaneIsmFactory,
  HyperlaneProxyFactoryDeployer,
  MultiProvider,
  TestCoreApp,
  TestCoreDeployer,
} from '@hyperlane-xyz/sdk';

import { HelloWorldConfig } from '../deploy/config';
import { HelloWorldDeployer } from '../deploy/deploy';
import { HelloWorld } from '../types';

describe('HelloWorld', async () => {
  const localChain = Chains.test1;
  const remoteChain = Chains.test2;
  let localDomain: number;
  let remoteDomain: number;

  let signer: SignerWithAddress;
  let local: HelloWorld;
  let remote: HelloWorld;
  let multiProvider: MultiProvider;
  let coreApp: TestCoreApp;
  let config: ChainMap<HelloWorldConfig>;

  before(async () => {
    [signer] = await ethers.getSigners();
    multiProvider = MultiProvider.createTestMultiProvider({ signer });
    const ismFactoryDeployer = new HyperlaneProxyFactoryDeployer(multiProvider);
    const ismFactory = new HyperlaneIsmFactory(
      await ismFactoryDeployer.deploy(multiProvider.mapKnownChains(() => ({}))),
      multiProvider,
    );
    coreApp = await new TestCoreDeployer(multiProvider, ismFactory).deployApp();
    config = coreApp.getRouterConfig(signer.address);

    localDomain = multiProvider.getDomainId(localChain);
    remoteDomain = multiProvider.getDomainId(remoteChain);
  });

  beforeEach(async () => {
    const helloWorld = new HelloWorldDeployer(multiProvider);
    const contracts = await helloWorld.deploy(config);

    local = contracts[localChain].router;
    remote = contracts[remoteChain].router;

    // The all counts start empty
    expect(await local.sent()).to.equal(0);
    expect(await local.received()).to.equal(0);
    expect(await remote.sent()).to.equal(0);
    expect(await remote.received()).to.equal(0);
  });

  it('sends a message', async () => {
    const body = 'Hello';
    const payment = await local['quoteDispatch(uint32,bytes)'](
      remoteDomain,
      Buffer.from(body),
    );
    await expect(
      local.sendHelloWorld(remoteDomain, body, {
        value: payment,
      }),
    ).to.emit(local, 'SentHelloWorld');
    // The sent counts are correct
    expect(await local.sent()).to.equal(1);
    expect(await local.sentTo(remoteDomain)).to.equal(1);
    // The received counts are correct
    expect(await local.received()).to.equal(0);
  });

  it('reverts if there is insufficient payment', async () => {
    const body = 'Hello';
    await expect(
      local.sendHelloWorld(remoteDomain, body, {
        value: 0,
      }),
    ).to.be.revertedWith('StaticProtocolFee: insufficient protocol fee');
  });

  it('handles a message', async () => {
    const body = 'World';
    const payment = await local['quoteDispatch(uint32,bytes)'](
      remoteDomain,
      Buffer.from(body),
    );
    await local.sendHelloWorld(remoteDomain, body, {
      value: payment,
    });
    // Mock processing of the message by Hyperlane
    await coreApp.processOutboundMessages(localChain);
    // The initial message has been dispatched.
    expect(await local.sent()).to.equal(1);
    // The initial message has been processed.
    expect(await remote.received()).to.equal(1);
    expect(await remote.receivedFrom(localDomain)).to.equal(1);
  });
});
