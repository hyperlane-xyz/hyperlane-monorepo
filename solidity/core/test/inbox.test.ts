/* eslint-disable @typescript-eslint/no-floating-promises */
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import { types, utils } from '@abacus-network/utils';

import {
  BadRecipient1__factory,
  BadRecipient2__factory,
  BadRecipient3__factory,
  BadRecipient5__factory,
  BadRecipient6__factory,
  TestInbox,
  TestInbox__factory,
  TestOutbox,
  TestOutbox__factory,
  TestRecipient__factory,
  ValidatorManager,
  ValidatorManager__factory,
} from '../types';

import { Checkpoint, MerkleProof, dispatchMessage } from './lib/mailboxes';
import { AggregatedSignature, ValidatorSet } from './lib/validators';

const OUTBOX_DOMAIN = 1234;
const INBOX_DOMAIN = 4321;
const SET_SIZE = 32;

describe('Inbox', async () => {
  const badRecipientFactories = [
    BadRecipient1__factory,
    BadRecipient2__factory,
    BadRecipient3__factory,
    BadRecipient5__factory,
    BadRecipient6__factory,
  ];

  let inbox: TestInbox,
    signer: SignerWithAddress,
    validatorManager: ValidatorManager,
    outbox: TestOutbox,
    validators: ValidatorSet,
    recipient: string;

  before(async () => {
    [signer] = await ethers.getSigners();

    // Deploy contracts
    const validatorManagerFactory = new ValidatorManager__factory(signer);
    validatorManager = await validatorManagerFactory.deploy();

    // Deploy a helper outbox contract so that we can easily construct merkle
    // proofs.
    const outboxFactory = new TestOutbox__factory(signer);
    outbox = await outboxFactory.deploy(OUTBOX_DOMAIN);
    await outbox.initialize(validatorManager.address);

    const domainHash = await outbox.domainHash();

    // Create and enroll validators
    validators = new ValidatorSet(SET_SIZE, validatorManager, domainHash);
    await validators.enroll(OUTBOX_DOMAIN);

    // Deploy a recipient
    const recipientF = new TestRecipient__factory(signer);
    recipient = utils.addressToBytes32((await recipientF.deploy()).address);
  });

  beforeEach(async () => {
    const inboxFactory = new TestInbox__factory(signer);
    inbox = await inboxFactory.deploy(INBOX_DOMAIN);
    await inbox.initialize(OUTBOX_DOMAIN, validatorManager.address);
  });

  it('Cannot be initialized twice', async () => {
    await expect(
      inbox.initialize(OUTBOX_DOMAIN, validatorManager.address),
    ).to.be.revertedWith('Initializable: contract is already initialized');
  });

  describe('#process', () => {
    let signature: AggregatedSignature,
      proof: MerkleProof,
      checkpoint: Checkpoint,
      message: string;

    before(async () => {
      const _r = await dispatchMessage(
        outbox,
        INBOX_DOMAIN,
        recipient,
        'hello world',
      );
      message = _r.message;
      checkpoint = _r.checkpoint;
      proof = _r.proof;
      signature = await validators.sign(checkpoint);
    });

    it('processes a message', async () => {
      await expect(
        inbox.process(signature, checkpoint, proof, message),
      ).to.emit(inbox, 'Process');
      expect(await inbox.messages(proof.item)).to.eql(
        types.MessageStatus.PROCESSED,
      );
    });

    it('Rejects an already-processed message', async () => {
      await inbox.setMessageStatus(proof.item, types.MessageStatus.PROCESSED);

      // Try to process message again
      await expect(
        inbox.process(signature, checkpoint, proof, message),
      ).to.be.revertedWith('!MessageStatus.None');
    });

    it('Rejects invalid message proof', async () => {
      // Switch ordering of proof hashes
      // NB: We copy 'path' here to avoid mutating the test cases for
      // other tests.
      const newBranch = proof.branch.slice().reverse();

      expect(
        inbox.process(
          signature,
          checkpoint,
          {
            branch: newBranch,
            item: proof.item,
            index: proof.index,
          },
          message,
        ),
      ).to.be.revertedWith('!proof');
      expect(await inbox.messages(proof.item)).to.equal(
        types.MessageStatus.NONE,
      );
    });

    it('Fails to process message when signature is invalid', async () => {
      await expect(
        inbox.process(
          {
            sig: signature.sig.add(1),
            randomness: signature.randomness,
            nonce: signature.nonce,
            missing: signature.missing,
          },
          checkpoint,
          proof,
          message,
        ),
      ).to.be.revertedWith('!sig');
    });

    for (let i = 0; i < badRecipientFactories.length; i++) {
      it(`Fails to process a message for a badly implemented recipient (${
        i + 1
      })`, async () => {
        const factory = new badRecipientFactories[i](signer);
        const badRecipient = await factory.deploy();

        const badDispatch = await dispatchMessage(
          outbox,
          INBOX_DOMAIN,
          utils.addressToBytes32(badRecipient.address),
          'hello world',
        );
        const badSig = await validators.sign(badDispatch.checkpoint);

        await expect(
          inbox.process(
            badSig,
            badDispatch.checkpoint,
            badDispatch.proof,
            badDispatch.message,
          ),
        ).to.be.reverted;
      });
    }

    it('Fails to process message with wrong destination Domain', async () => {
      const badDispatch = await dispatchMessage(
        outbox,
        INBOX_DOMAIN + 1,
        recipient,
        'hello world',
      );
      const badSig = await validators.sign(badDispatch.checkpoint);

      await expect(
        inbox.process(
          badSig,
          badDispatch.checkpoint,
          badDispatch.proof,
          badDispatch.message,
        ),
      ).to.be.revertedWith('!destination');
    });

    it('Fails to process message sent to a non-existent contract address', async () => {
      const badDispatch = await dispatchMessage(
        outbox,
        INBOX_DOMAIN,
        utils.addressToBytes32('0x1234567890123456789012345678901234567890'), // non-existent contract address
        'hello world',
      );
      const badSig = await validators.sign(badDispatch.checkpoint);
      await expect(
        inbox.process(
          badSig,
          badDispatch.checkpoint,
          badDispatch.proof,
          badDispatch.message,
        ),
      ).to.be.reverted;
    });
  });

  // Because the Outbox only gives us proofs against the latest root, we can
  // only easily create one proof against a checkpoint.
  describe.skip('#batchProcess', () => {
    let signature: AggregatedSignature,
      checkpoint: Checkpoint,
      proofs: MerkleProof[],
      messages: string[];

    before(async () => {
      const MESSAGES = 100;
      const MESSAGE_WORDS = 1;

      const dispatches = [];
      for (let i = 0; i < MESSAGES; i++) {
        const message = ethers.utils.hexlify(
          ethers.utils.randomBytes(MESSAGE_WORDS * 32),
        );
        dispatches.push(
          await dispatchMessage(outbox, INBOX_DOMAIN, recipient, message),
        );
      }
      const latest = dispatches[dispatches.length - 1];
      checkpoint = latest.checkpoint;
      signature = await validators.sign(checkpoint);
      proofs = dispatches.map((m) => m.proof);
      messages = dispatches.map((m) => m.message);
    });

    it('processes multiple messages', async () => {
      await expect(
        inbox.batchProcess(signature, checkpoint, proofs, messages),
      ).to.emit(validatorManager, 'BatchProcess');
    });

    it('reverts if the signature is invalid', async () => {
      await expect(
        inbox.batchProcess(
          {
            sig: signature.sig.add(1),
            randomness: signature.randomness,
            nonce: signature.nonce,
            missing: signature.missing,
          },
          checkpoint,
          proofs,
          messages,
        ),
      ).to.be.reverted;
    });

    it('reverts if the proofs are out of order', async () => {
      await expect(
        inbox.batchProcess(
          signature,
          checkpoint,
          proofs.slice().reverse(),
          messages,
        ),
      ).to.be.reverted;
    });
  });
});
