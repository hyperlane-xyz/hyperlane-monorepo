import { expect } from 'chai';
import { utils } from 'ethers';

import {
  addressToBytes32,
  formatMessage,
  messageId,
} from '@hyperlane-xyz/utils';

import testCases from '../../vectors/message.json' assert { type: 'json' };
import {
  Mailbox__factory,
  MerkleTreeHook__factory,
  RpcMultisigIsm__factory,
  TestIsm__factory,
  TestMessage,
  TestMessage__factory,
  TestRecipient__factory,
} from '../types';
import { DispatchEvent } from '../types/contracts/Mailbox';

import { getSigner, getSigners } from './signer';

const remoteDomain = 1000;
const localDomain = 2000;
const nonce = 11;

describe.only('RPC Validator', async () => {
  it('test2', async () => {
    const signer = await getSigner();

    const Mailbox = new Mailbox__factory(signer);
    const originMailbox = await Mailbox.deploy(localDomain);
    const merkleTreeHook = await new MerkleTreeHook__factory(signer).deploy(
      originMailbox.address,
    );
    const testIsm = await new TestIsm__factory(signer).deploy();
    originMailbox.initialize(
      signer.address,
      testIsm.address,
      merkleTreeHook.address,
      merkleTreeHook.address,
    );

    const rpcValidatorIsm = await new RpcMultisigIsm__factory(signer).deploy(
      'http://localhost:8545',
      [signer.address],
      1,
    );
    const destinationMailbox = await Mailbox.deploy(remoteDomain);
    destinationMailbox.initialize(
      signer.address,
      rpcValidatorIsm.address,
      merkleTreeHook.address,
      merkleTreeHook.address,
    );

    const testRecipient = await new TestRecipient__factory(signer).deploy();

    const tx = await originMailbox['dispatch(uint32,bytes32,bytes)'](
      remoteDomain,
      addressToBytes32(testRecipient.address),
      utils.formatBytes32String('message'),
    );

    const receipt = await tx.wait();
    const parsedLogs = receipt.logs.map((log) => {
      try {
        return Mailbox.interface.parseLog(log);
      } catch (error) {
        try {
          return merkleTreeHook.interface.parseLog(log);
        } catch (error) {
          return null;
        }
      }
    });

    const dispatchEvent = parsedLogs.find(
      (_) => _!.name === 'Dispatch',
    ) as unknown as DispatchEvent;
    await destinationMailbox['recipientIsm(address)'](testRecipient.address);

    await rpcValidatorIsm.verify(
      utils.formatBytes32String('message'),
      dispatchEvent.args!.message,
    );
    // await destinationMailbox.process(
    //   utils.formatBytes32String('message'),
    //   dispatchEvent.args!.message,
    // );
  });

  it('test', async () => {
    expect(true).to.equal(true);
  });
});

describe('Message', async () => {
  let messageLib: TestMessage;
  let version: number;

  before(async () => {
    const signer = await getSigner();

    const Message = new TestMessage__factory(signer);
    messageLib = await Message.deploy();

    // For consistency with the Mailbox version
    const Mailbox = new Mailbox__factory(signer);
    const mailbox = await Mailbox.deploy(localDomain);
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
