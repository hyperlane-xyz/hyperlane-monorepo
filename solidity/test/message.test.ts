import { Deployer } from '@matterlabs/hardhat-zksync-deploy';
import { expect } from 'chai';
import { utils } from 'ethers';
import hre from 'hardhat';
import { Provider, Wallet } from 'zksync-ethers';

import {
  addressToBytes32,
  formatMessage,
  messageId,
} from '@hyperlane-xyz/utils';

import testCases from '../../vectors/message.json' assert { type: 'json' };
import { Mailbox__factory, TestMessage, TestMessage__factory } from '../types';

import { getSigner, getSigners } from './signer';

const remoteDomain = 1000;
const localDomain = 2000;
const nonce = 11;

describe('Message', async () => {
  let messageLib: any;
  let version: number;

  before(async () => {
    const provider = new Provider('http://127.0.0.1:8011');

    const deployerWallet = new Wallet(
      '0x3d3cbc973389cb26f657686445bcc75662b415b656078503592ac8c1abb8810e',
      provider,
    );
    const deployer = new Deployer(hre, deployerWallet);
    let artifact = await deployer.loadArtifact('TestMessage');
    messageLib = await deployer.deploy(artifact, []);

    artifact = await deployer.loadArtifact('Mailbox');
    const mailbox = await deployer.deploy(artifact, [localDomain]);

    version = await mailbox.VERSION();
  });

  it('Returns fields from a message', async () => {
    const [sender, recipient] = await getSigners();
    const body = utils.formatBytes32String('message');

    const message = formatMessage(
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
      addressToBytes32(sender.address),
    );
    expect(await messageLib.destination(message)).to.equal(localDomain);
    expect(await messageLib.recipient(message)).to.equal(
      addressToBytes32(recipient.address),
    );
    expect(await messageLib.recipientAddress(message)).to.equal(
      recipient.address,
    );
    expect(await messageLib.body(message)).to.equal(body);
  });

  it('Matches Rust-output HyperlaneMessage and leaf', async () => {
    for (const test of testCases) {
      const { origin, sender, destination, recipient, body, nonce, id } = test;

      const hexBody = utils.hexlify(body);

      const hyperlaneMessage = formatMessage(
        version,
        nonce,
        origin,
        sender,
        destination,
        recipient,
        hexBody,
      );

      expect(await messageLib.origin(hyperlaneMessage)).to.equal(origin);
      expect(await messageLib.sender(hyperlaneMessage)).to.equal(sender);
      expect(await messageLib.destination(hyperlaneMessage)).to.equal(
        destination,
      );
      expect(await messageLib.recipient(hyperlaneMessage)).to.equal(recipient);
      expect(await messageLib.body(hyperlaneMessage)).to.equal(hexBody);
      expect(messageId(hyperlaneMessage)).to.equal(id);
    }
  });
});
