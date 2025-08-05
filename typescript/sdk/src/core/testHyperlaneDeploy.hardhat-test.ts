import '@nomiclabs/hardhat-ethers';
import '@nomiclabs/hardhat-waffle';
import { expect } from 'chai';
import { ContractReceipt } from 'ethers';
import hre from 'hardhat';

import { TestMailbox, TestRecipient__factory } from '@hyperlane-xyz/core';
import { addressToBytes32 } from '@hyperlane-xyz/utils';

import { TestChainName } from '../consts/testChains.js';
import { HyperlaneProxyFactoryDeployer } from '../deploy/HyperlaneProxyFactoryDeployer.js';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
import { MultiProvider } from '../providers/MultiProvider.js';

import { TestCoreApp } from './TestCoreApp.js';
import { TestCoreDeployer } from './TestCoreDeployer.js';

const localChain = TestChainName.test1;
const remoteChain = TestChainName.test2;
const message = '0xdeadbeef';

describe('TestCoreDeployer', async () => {
  let testCoreApp: TestCoreApp,
    localMailbox: TestMailbox,
    remoteMailbox: TestMailbox,
    dispatchReceipt: ContractReceipt;

  beforeEach(async () => {
    const [signer] = await hre.ethers.getSigners();

    const multiProvider = MultiProvider.createTestMultiProvider({ signer });

    const ismFactoryDeployer = new HyperlaneProxyFactoryDeployer(multiProvider);
    const ismFactory = new HyperlaneIsmFactory(
      await ismFactoryDeployer.deploy(multiProvider.mapKnownChains(() => ({}))),
      multiProvider,
    );
    const deployer = new TestCoreDeployer(multiProvider, ismFactory);
    testCoreApp = await deployer.deployApp();

    const recipient = await new TestRecipient__factory(signer).deploy();
    localMailbox = testCoreApp.getContracts(localChain).mailbox;

    const interchainGasPayment = await localMailbox[
      'quoteDispatch(uint32,bytes32,bytes)'
    ](
      multiProvider.getDomainId(remoteChain),
      addressToBytes32(recipient.address),
      message,
    );

    const dispatchResponse = localMailbox['dispatch(uint32,bytes32,bytes)'](
      multiProvider.getDomainId(remoteChain),
      addressToBytes32(recipient.address),
      message,
      { value: interchainGasPayment },
    );
    await expect(dispatchResponse).to.emit(localMailbox, 'Dispatch');
    dispatchReceipt = await testCoreApp.multiProvider.handleTx(
      localChain,
      dispatchResponse,
    );
    remoteMailbox = testCoreApp.getContracts(remoteChain).mailbox;
    await expect(
      remoteMailbox['dispatch(uint32,bytes32,bytes)'](
        multiProvider.getDomainId(localChain),
        addressToBytes32(recipient.address),
        message,
        { value: interchainGasPayment },
      ),
    ).to.emit(remoteMailbox, 'Dispatch');
  });

  it('processes outbound messages for a single domain', async () => {
    const responses = await testCoreApp.processOutboundMessages(localChain);
    expect(responses.get(remoteChain)!.length).to.equal(1);
  });

  it('processes outbound messages for two domains', async () => {
    const localResponses =
      await testCoreApp.processOutboundMessages(localChain);
    expect(localResponses.get(remoteChain)!.length).to.equal(1);
    const remoteResponses =
      await testCoreApp.processOutboundMessages(remoteChain);
    expect(remoteResponses.get(localChain)!.length).to.equal(1);
  });

  it('processes all messages', async () => {
    const responses = await testCoreApp.processMessages();
    expect(responses.get(localChain)!.get(remoteChain)!.length).to.equal(1);
    expect(responses.get(remoteChain)!.get(localChain)!.length).to.equal(1);
  });

  it('waits on message processing receipts', async () => {
    const [receipts] = await Promise.all([
      testCoreApp.waitForMessageProcessing(dispatchReceipt),
      testCoreApp.processOutboundMessages(localChain),
    ]);
    expect(receipts).to.have.length(1);
  });
});
