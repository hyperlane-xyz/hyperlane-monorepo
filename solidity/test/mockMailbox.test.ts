import { expect } from 'chai';
import { utils } from 'ethers';

import { addressToBytes32 } from '@hyperlane-xyz/utils';

// @ts-ignore CJS is confusing TS, required for hardhat
import Types from '../types';

import { getSigner } from './signer';

const ORIGIN_DOMAIN = 1000;
const DESTINATION_DOMAIN = 2000;

describe('MockMailbox', function () {
  it('should be able to mock sending and receiving a message', async function () {
    const signer = await getSigner();
    const mailboxFactory = new Types.MockMailbox__factory(signer);
    const testRecipientFactory = new Types.TestRecipient__factory(signer);
    const originMailbox = await mailboxFactory.deploy(ORIGIN_DOMAIN);
    const destinationMailbox = await mailboxFactory.deploy(DESTINATION_DOMAIN);
    await originMailbox.addRemoteMailbox(
      DESTINATION_DOMAIN,
      destinationMailbox.address,
    );
    const recipient = await testRecipientFactory.deploy();

    const body = utils.toUtf8Bytes('This is a test message');

    await originMailbox['dispatch(uint32,bytes32,bytes)'](
      DESTINATION_DOMAIN,
      addressToBytes32(recipient.address),
      body,
    );
    await destinationMailbox.processNextInboundMessage();

    const dataReceived = await recipient.lastData();
    expect(dataReceived).to.eql(utils.hexlify(body));
  });
});
