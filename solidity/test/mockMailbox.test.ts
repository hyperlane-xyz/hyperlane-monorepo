import { expect } from 'chai';
import { hexlify, toUtf8Bytes } from 'ethers';

import { addressToBytes32 } from '@hyperlane-xyz/utils';

import {
  MockMailbox__factory,
  TestRecipient__factory,
} from '../core-utils/typechain';

import { getSigner } from './signer';

const ORIGIN_DOMAIN = 1000;
const DESTINATION_DOMAIN = 2000;

describe('MockMailbox', function () {
  it('should be able to mock sending and receiving a message', async function () {
    const signer = await getSigner();
    const mailboxFactory = new MockMailbox__factory(signer);
    const testRecipientFactory = new TestRecipient__factory(signer);
    const originMailbox = await mailboxFactory.deploy(ORIGIN_DOMAIN);
    const destinationMailbox = await mailboxFactory.deploy(DESTINATION_DOMAIN);
    const destinationMailboxAddress = await destinationMailbox.getAddress();
    await originMailbox.addRemoteMailbox(
      DESTINATION_DOMAIN,
      destinationMailboxAddress,
    );
    const recipient = await testRecipientFactory.deploy();
    const recipientAddress = await recipient.getAddress();

    const body = toUtf8Bytes('This is a test message');

    await originMailbox['dispatch(uint32,bytes32,bytes)'](
      DESTINATION_DOMAIN,
      addressToBytes32(recipientAddress),
      body,
    );
    await destinationMailbox.processNextInboundMessage();

    const dataReceived = await recipient.lastData();
    expect(dataReceived).to.eql(hexlify(body));
  });
});
