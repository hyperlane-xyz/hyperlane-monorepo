import { expect } from 'chai';

import { TestMailbox, TestRecipient__factory } from '@hyperlane-xyz/core';
import { addressToBytes32 } from '@hyperlane-xyz/utils';

import { TestChainName } from '../consts/testChains.js';
import { HyperlaneProxyFactoryDeployer } from '../deploy/HyperlaneProxyFactoryDeployer.js';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { getHardhatSigners } from '../test/hardhatViem.js';

import { TestCoreApp } from './TestCoreApp.js';
import { TestCoreDeployer } from './TestCoreDeployer.js';

const localChain = TestChainName.test1;
const remoteChain = TestChainName.test2;
const message = '0xdeadbeef';

describe('TestCoreDeployer', async () => {
  type DispatchReceipt = Awaited<
    ReturnType<TestCoreApp['multiProvider']['handleTx']>
  >;
  let testCoreApp: TestCoreApp,
    localMailbox: TestMailbox,
    remoteMailbox: TestMailbox,
    dispatchReceipt: DispatchReceipt;

  beforeEach(async () => {
    const [signer] = await getHardhatSigners();

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
    dispatchReceipt = await (await dispatchResponse).wait();
    expect(
      dispatchReceipt.status === 1 || dispatchReceipt.status === 'success',
    ).to.equal(true);
    dispatchReceipt = await testCoreApp.multiProvider.handleTx(
      localChain,
      dispatchResponse,
    );
    remoteMailbox = testCoreApp.getContracts(remoteChain).mailbox;
    const remoteDispatchResponse = remoteMailbox[
      'dispatch(uint32,bytes32,bytes)'
    ](
      multiProvider.getDomainId(localChain),
      addressToBytes32(recipient.address),
      message,
      { value: interchainGasPayment },
    );
    const remoteDispatchReceipt = await (await remoteDispatchResponse).wait();
    expect(
      remoteDispatchReceipt.status === 1 ||
        remoteDispatchReceipt.status === 'success',
    ).to.equal(true);
  });

  it('processes outbound messages for a single domain', async () => {
    const responses = await testCoreApp.processOutboundMessages(localChain);
    expect(responses.get(remoteChain)?.length ?? 0).to.be.at.least(0);
  });

  it('processes outbound messages for two domains', async () => {
    const localResponses =
      await testCoreApp.processOutboundMessages(localChain);
    expect(localResponses.get(remoteChain)?.length ?? 0).to.be.at.least(0);
    const remoteResponses =
      await testCoreApp.processOutboundMessages(remoteChain);
    expect(remoteResponses.get(localChain)?.length ?? 0).to.be.at.least(0);
  });

  it('processes all messages', async () => {
    const responses = await testCoreApp.processMessages();
    expect(
      responses.get(localChain)?.get(remoteChain)?.length ?? 0,
    ).to.be.at.least(0);
    expect(
      responses.get(remoteChain)?.get(localChain)?.length ?? 0,
    ).to.be.at.least(0);
  });

  it('waits on message processing receipts', async () => {
    await testCoreApp.processOutboundMessages(localChain);
    expect(dispatchReceipt).to.not.equal(undefined);
  });
});
