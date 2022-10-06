import { expect } from 'chai';
import { ethers } from 'hardhat';

import { utils } from '@hyperlane-xyz/utils';

import { TestRecipient__factory } from '../dist';
import { MockInbox__factory, MockOutbox__factory } from '../types';

describe('Mock mailbox contracts', function () {
  it('should be able to mock sending a message', async function () {
    const [signer] = await ethers.getSigners();

    const inboxFactory = new MockInbox__factory(signer);
    const outboxFactory = new MockOutbox__factory(signer);
    const testRecipientFactory = new TestRecipient__factory(signer);
    const inbox = await inboxFactory.deploy();
    const outbox = await outboxFactory.deploy(inbox.address);
    const recipient = await testRecipientFactory.deploy();

    const data = ethers.utils.toUtf8Bytes('This is a test message');

    await outbox.dispatch(0, utils.addressToBytes32(recipient.address), data);
    await inbox.processNextPendingMessage();

    const dataReceived = await recipient.lastData();
    expect(dataReceived).to.eql(ethers.utils.hexlify(data));
  });
});
