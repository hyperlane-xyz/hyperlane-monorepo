import { expect } from 'chai';
import hre from 'hardhat';
import { bytesToHex, isHex, pad, stringToHex } from 'viem';

import {
  addressToBytes32,
  formatMessage,
  messageId,
} from '@hyperlane-xyz/utils';

import testCases from '../../vectors/message.json' with { type: 'json' };

import { getSigners } from './signer.js';

const remoteDomain = 1000;
const localDomain = 2000;
const nonce = 11;

describe('Message', async () => {
  let messageLib: any;
  let version: number;

  function normalizeHexBody(body: unknown): `0x${string}` {
    if (typeof body === 'string') {
      if (isHex(body)) return body;
      const prefixedBody = `0x${body}`;
      if (isHex(prefixedBody)) return prefixedBody;
      return stringToHex(body);
    }
    if (Array.isArray(body) && body.every((value) => typeof value === 'number')) {
      return bytesToHex(Uint8Array.from(body));
    }
    throw new Error(`Unsupported message body type: ${typeof body}`);
  }

  before(async () => {
    messageLib = await hre.viem.deployContract('TestMessage');
    const mailbox = await hre.viem.deployContract('Mailbox', [localDomain]);
    version = Number(await mailbox.read.VERSION());
  });

  it('Returns fields from a message', async () => {
    const [sender, recipient] = await getSigners();
    if (!sender?.account || !recipient?.account) {
      throw new Error('Expected configured hardhat wallet accounts');
    }
    const body = pad(stringToHex('message'), { dir: 'right', size: 32 });

    const message = formatMessage(
      version,
      nonce,
      remoteDomain,
      sender.account.address,
      localDomain,
      recipient.account.address,
      body,
    );

    expect(Number(await messageLib.read.version([message]))).to.equal(version);
    expect(Number(await messageLib.read.nonce([message]))).to.equal(nonce);
    expect(Number(await messageLib.read.origin([message]))).to.equal(
      remoteDomain,
    );
    expect(await messageLib.read.sender([message])).to.equal(
      addressToBytes32(sender.account.address),
    );
    expect(Number(await messageLib.read.destination([message]))).to.equal(
      localDomain,
    );
    expect(await messageLib.read.recipient([message])).to.equal(
      addressToBytes32(recipient.account.address),
    );
    expect(
      (await messageLib.read.recipientAddress([message])).toLowerCase(),
    ).to.equal(recipient.account.address.toLowerCase());
    expect(await messageLib.read.body([message])).to.equal(body);
  });

  it('Matches Rust-output HyperlaneMessage and leaf', async () => {
    for (const test of testCases) {
      const { origin, sender, destination, recipient, body, nonce, id } = test;

      const hexBody = normalizeHexBody(body);

      const hyperlaneMessage = formatMessage(
        version,
        nonce,
        origin,
        sender,
        destination,
        recipient,
        hexBody,
      );

      expect(Number(await messageLib.read.origin([hyperlaneMessage]))).to.equal(
        origin,
      );
      expect(await messageLib.read.sender([hyperlaneMessage])).to.equal(sender);
      expect(
        Number(await messageLib.read.destination([hyperlaneMessage])),
      ).to.equal(destination);
      expect(await messageLib.read.recipient([hyperlaneMessage])).to.equal(
        recipient,
      );
      expect(await messageLib.read.body([hyperlaneMessage])).to.equal(hexBody);
      expect(messageId(hyperlaneMessage)).to.equal(id);
    }
  });
});
