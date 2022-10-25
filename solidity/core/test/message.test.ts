import { expect } from 'chai';
import { ethers } from 'hardhat';

import { utils } from '@hyperlane-xyz/utils';

import { TestMessage, TestMessage__factory } from '../types';

const testCases = require('../../../vectors/message.json');

const remoteDomain = 1000;
const localDomain = 2000;
const version = 0;
const nonce = 11;

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
      version,
      nonce,
      remoteDomain,
      sender.address,
      localDomain,
      recipient.address,
      body,
    );

    expect(await messageLib.version(message)).to.equal(version);
    expect(await messageLib.nonce(message)).to.equal(nonce);
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

  it('Matches Rust-output HyperlaneMessage and leaf', async () => {
    const origin = 1000;
    const sender = '0x1111111111111111111111111111111111111111';
    const destination = 2000;
    const recipient = '0x2222222222222222222222222222222222222222';
    const body = '0x1234';

    const hyperlaneMessage = utils.formatMessage(
      version,
      nonce,
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

    expect(await messageLib.origin(hyperlaneMessage)).to.equal(testOrigin);
    expect(await messageLib.sender(hyperlaneMessage)).to.equal(testSender);
    expect(await messageLib.destination(hyperlaneMessage)).to.equal(
      testDestination,
    );
    expect(await messageLib.recipient(hyperlaneMessage)).to.equal(
      testRecipient,
    );
    expect(await messageLib.body(hyperlaneMessage)).to.equal(
      ethers.utils.hexlify(testBody),
    );
    expect(utils.messageId(hyperlaneMessage)).to.equal(messageHash);
  });
});
