import '@nomiclabs/hardhat-ethers';
import '@nomiclabs/hardhat-waffle';
import { expect } from 'chai';
import { ContractReceipt } from 'ethers';
import { ethers } from 'hardhat';

import { TestMailbox, TestRecipient__factory } from '@hyperlane-xyz/core';
import { utils } from '@hyperlane-xyz/utils';

import { chainMetadata } from '../consts/chainMetadata';
import { getTestMultiProvider } from '../deploy/utils';

import { TestCoreApp } from './TestCoreApp';
import { TestCoreDeployer } from './TestCoreDeployer';

const localChain = 'test1';
const localDomain = chainMetadata[localChain].id;
const remoteChain = 'test2';
const remoteDomain = chainMetadata[remoteChain].id;
const message = '0xdeadbeef';

describe('TestCoreDeployer', async () => {
  let testCoreApp: TestCoreApp,
    localMailbox: TestMailbox,
    remoteMailbox: TestMailbox,
    dispatchReceipt: ContractReceipt;

  beforeEach(async () => {
    const [signer] = await ethers.getSigners();

    const multiProvider = getTestMultiProvider(signer);
    const deployer = new TestCoreDeployer(multiProvider);
    testCoreApp = await deployer.deployApp();

    const recipient = await new TestRecipient__factory(signer).deploy();
    localMailbox = testCoreApp.getContracts(localChain).mailbox.contract;

    const dispatchResponse = localMailbox.dispatch(
      remoteDomain,
      utils.addressToBytes32(recipient.address),
      message,
    );
    await expect(dispatchResponse).to.emit(localMailbox, 'Dispatch');
    dispatchReceipt = await testCoreApp.multiProvider
      .getChainConnection(localChain)
      .handleTx(dispatchResponse);
    remoteMailbox = testCoreApp.getContracts(remoteChain).mailbox.contract;
    await expect(
      remoteMailbox.dispatch(
        localDomain,
        utils.addressToBytes32(recipient.address),
        message,
      ),
    ).to.emit(remoteMailbox, 'Dispatch');
  });

  it('processes outbound messages for a single domain', async () => {
    const responses = await testCoreApp.processOutboundMessages(localChain);
    expect(responses.get(remoteChain)!.length).to.equal(1);
  });

  it('processes outbound messages for two domains', async () => {
    const localResponses = await testCoreApp.processOutboundMessages(
      localChain,
    );
    expect(localResponses.get(remoteChain)!.length).to.equal(1);
    const remoteResponses = await testCoreApp.processOutboundMessages(
      remoteChain,
    );
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
