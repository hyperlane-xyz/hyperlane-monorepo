import { expect } from 'chai';
import { ethers } from 'hardhat';

import { utils } from '@hyperlane-xyz/utils';

import { TestMessage, TestMessage__factory } from '../types';

const testCases = require('../../vectors/message.json');

const remoteDomain = 1000;
const localDomain = 2000;

describe('Message', async () => {
  let messageLib: TestMessage;

  before(async () => {
    const [signer] = await ethers.getSigners();

    const Message = new TestMessage__factory(signer);
    messageLib = await Message.deploy();
  });

  it('Returns fields from a message', async () => {
    const [sender, recipient] = await ethers.getSigners();
    const body = ethers.utils.formatBytes32String('message');

    const message = utils.formatMessage(
      remoteDomain,
      sender.address,
      localDomain,
      recipient.address,
      body,
    );

    expect(await messageLib.origin(message)).to.equal(remoteDomain);
    expect(await messageLib.sender(message)).to.equal(
      utils.addressToBytes32(sender.address),
    );
    expect(await messageLib.destination(message)).to.equal(localDomain);
    expect(await messageLib.recipient(message)).to.equal(
      utils.addressToBytes32(recipient.address),
    );
    expect(await messageLib.recipientAddress(message)).to.equal(
      recipient.address,
    );
    expect(await messageLib.body(message)).to.equal(body);
  });

  it('Matches Rust-output AbacusMessage and leaf', async () => {
    const origin = 1000;
    const sender = '0x1111111111111111111111111111111111111111';
    const destination = 2000;
    const recipient = '0x2222222222222222222222222222222222222222';
    const body = '0x1234';

    const leafIndex = 0;
    const abacusMessage = utils.formatMessage(
      origin,
      sender,
      destination,
      recipient,
      body,
    );

    const {
      origin: testOrigin,
      sender: testSender,
      destination: testDestination,
      recipient: testRecipient,
      body: testBody,
      messageHash,
    } = testCases[0];

    expect(await messageLib.origin(abacusMessage)).to.equal(testOrigin);
    expect(await messageLib.sender(abacusMessage)).to.equal(testSender);
    expect(await messageLib.destination(abacusMessage)).to.equal(
      testDestination,
    );
    expect(await messageLib.recipient(abacusMessage)).to.equal(testRecipient);
    expect(await messageLib.body(abacusMessage)).to.equal(
      ethers.utils.hexlify(testBody),
    );
    expect(await messageLib.leaf(abacusMessage, leafIndex)).to.equal(
      messageHash,
    );
    expect(utils.messageHash(abacusMessage, leafIndex)).to.equal(messageHash);
  });
});
