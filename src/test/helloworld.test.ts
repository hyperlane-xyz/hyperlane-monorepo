import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import {
  ChainMap,
  Chains,
  MultiProvider,
  TestCoreApp,
  TestCoreDeployer,
  deployTestIgpsAndGetRouterConfig,
} from '@hyperlane-xyz/sdk';

import { HelloWorldConfig } from '../deploy/config';
import { HelloWorldDeployer } from '../deploy/deploy';
import {
  HelloWorld,
  IInterchainGasPaymaster,
  IInterchainGasPaymaster__factory,
} from '../types';

describe('HelloWorld', async () => {
  const localChain = Chains.test1;
  const remoteChain = Chains.test2;
  let localDomain: number;
  let remoteDomain: number;

  let signer: SignerWithAddress;
  let local: HelloWorld;
  let remote: HelloWorld;
  let localIgp: IInterchainGasPaymaster;
  let multiProvider: MultiProvider;
  let coreApp: TestCoreApp;
  let config: ChainMap<HelloWorldConfig>;

  before(async () => {
    [signer] = await ethers.getSigners();

    multiProvider = MultiProvider.createTestMultiProvider({ signer });
    localDomain = multiProvider.getDomainId(localChain);
    remoteDomain = multiProvider.getDomainId(remoteChain);

    const coreDeployer = new TestCoreDeployer(multiProvider);
    const coreContractsMaps = await coreDeployer.deploy();
    coreApp = new TestCoreApp(coreContractsMaps, multiProvider);
    config = await deployTestIgpsAndGetRouterConfig(
      multiProvider,
      signer.address,
      coreContractsMaps,
    );
  });

  beforeEach(async () => {
    const helloWorld = new HelloWorldDeployer(multiProvider, config, coreApp);
    const contracts = await helloWorld.deploy();

    local = contracts[localChain].router;
    remote = contracts[remoteChain].router;
    localIgp = IInterchainGasPaymaster__factory.connect(
      config[localChain].interchainGasPaymaster,
      multiProvider.getProvider(localChain),
    );

    // The all counts start empty
    expect(await local.sent()).to.equal(0);
    expect(await local.received()).to.equal(0);
    expect(await remote.sent()).to.equal(0);
    expect(await remote.received()).to.equal(0);
  });

  async function quoteGasPayment(
    fromRouter: HelloWorld,
    destinationDomain: number,
    igp: IInterchainGasPaymaster,
  ) {
    const handleGasAmount = await fromRouter.HANDLE_GAS_AMOUNT();
    return igp.quoteGasPayment(destinationDomain, handleGasAmount);
  }

  it('sends a message', async () => {
    await expect(
      local.sendHelloWorld(remoteDomain, 'Hello', {
        value: await quoteGasPayment(local, remoteDomain, localIgp),
      }),
    ).to.emit(local, 'SentHelloWorld');
    // The sent counts are correct
    expect(await local.sent()).to.equal(1);
    expect(await local.sentTo(remoteDomain)).to.equal(1);
    // The received counts are correct
    expect(await local.received()).to.equal(0);
  });

  it('reverts if there is insufficient payment', async () => {
    await expect(
      local.sendHelloWorld(remoteDomain, 'Hello', {
        value: 0,
      }),
    ).to.be.revertedWith('insufficient interchain gas payment');
  });

  it('handles a message', async () => {
    await local.sendHelloWorld(remoteDomain, 'World', {
      value: await quoteGasPayment(local, remoteDomain, localIgp),
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
