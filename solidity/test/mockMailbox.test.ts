import { expect } from 'chai';
import { ethers } from 'hardhat';

import { utils } from '@hyperlane-xyz/utils';

import { MockMailbox__factory, TestRecipient__factory } from '../types';

const ORIGIN_DOMAIN = 1000;
const DESTINATION_DOMAIN = 2000;

describe('MockMailbox', function () {
  it('should be able to mock sending and receiving a message', async function () {
    const [signer] = await ethers.getSigners();
    const mailboxFactory = new MockMailbox__factory(signer);
    const testRecipientFactory = new TestRecipient__factory(signer);
    const originMailbox = await mailboxFactory.deploy(ORIGIN_DOMAIN);
    const destinationMailbox = await mailboxFactory.deploy(DESTINATION_DOMAIN);
    await originMailbox.addRemoteMailbox(
      DESTINATION_DOMAIN,
      destinationMailbox.address,
    );
    const recipient = await testRecipientFactory.deploy();

    const body = ethers.utils.toUtf8Bytes('This is a test message');

    await originMailbox.dispatch(
      DESTINATION_DOMAIN,
      utils.addressToBytes32(recipient.address),
      body,
    );
    await destinationMailbox.processNextInboundMessage();

    const dataReceived = await recipient.lastData();
    expect(dataReceived).to.eql(ethers.utils.hexlify(body));
  });
});
