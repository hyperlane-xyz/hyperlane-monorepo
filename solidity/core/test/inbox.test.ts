/* eslint-disable @typescript-eslint/no-floating-promises */
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import { types, utils } from '@hyperlane-xyz/utils';

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
  TestValidatorManager,
  TestValidatorManager__factory,
} from '../types';

import { MerkleProof, dispatchMessageAndReturnProof } from './lib/mailboxes';

const localDomain = 3000;
const remoteDomain = 1000;

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
    validatorManager: TestValidatorManager,
    helperOutbox: TestOutbox,
    recipient: string,
    proof: MerkleProof;

  before(async () => {
    [signer] = await ethers.getSigners();
    // Inbox.initialize will ensure the validator manager is a contract.
    // TestValidatorManager doesn't have any special logic, it just forwards
    // calls to Inbox.process.
    const testValidatorManagerFactory = new TestValidatorManager__factory(
      signer,
    );
    validatorManager = await testValidatorManagerFactory.deploy();
    const recipientF = new TestRecipient__factory(signer);
    recipient = utils.addressToBytes32((await recipientF.deploy()).address);

    // Deploy a helper outbox contract so that we can easily construct merkle
    // proofs.
    const outboxFactory = new TestOutbox__factory(signer);
    helperOutbox = await outboxFactory.deploy(localDomain);
    await helperOutbox.initialize(validatorManager.address);

    proof = await dispatchMessageAndReturnProof(
      helperOutbox,
      remoteDomain,
      recipient,
      'hello world',
    );
  });

  beforeEach(async () => {
    const inboxFactory = new TestInbox__factory(signer);
    inbox = await inboxFactory.deploy(remoteDomain);
    await inbox.initialize(localDomain, validatorManager.address);
  });

  it('Cannot be initialized twice', async () => {
    await expect(
      inbox.initialize(localDomain, validatorManager.address),
    ).to.be.revertedWith('Initializable: contract is already initialized');
  });

  it('processes a message', async () => {
    await expect(
      validatorManager.process(
        inbox.address,
        proof.root,
        proof.index,
        proof.message,
        proof.proof,
        proof.index,
      ),
    ).to.emit(inbox, 'Process');
    expect(await inbox.messages(proof.leaf)).to.eql(
      types.MessageStatus.PROCESSED,
    );
  });

  it('Rejects an already-processed message', async () => {
    await inbox.setMessageStatus(proof.leaf, types.MessageStatus.PROCESSED);

    // Try to process message again
    await expect(
      validatorManager.process(
        inbox.address,
        proof.root,
        proof.index,
        proof.message,
        proof.proof,
        proof.index,
      ),
    ).to.be.revertedWith('!MessageStatus.None');
  });

  it('Rejects invalid message proof', async () => {
    // Switch ordering of proof hashes
    // NB: We copy 'path' here to avoid mutating the test cases for
    // other tests.
    const newProof = proof.proof.slice().reverse();

    expect(
      validatorManager.process(
        inbox.address,
        proof.root,
        proof.index,
        proof.message,
        newProof,
        proof.index,
      ),
    ).to.be.revertedWith('!proof');
    expect(await inbox.messages(proof.leaf)).to.equal(types.MessageStatus.NONE);
  });

  it('Fails to process message when not called by validator manager', async () => {
    await expect(
      inbox.process(
        proof.root,
        proof.index,
        proof.message,
        proof.proof,
        proof.index,
      ),
    ).to.be.revertedWith('!validatorManager');
  });

  for (let i = 0; i < badRecipientFactories.length; i++) {
    it(`Fails to process a message for a badly implemented recipient (${
      i + 1
    })`, async () => {
      const factory = new badRecipientFactories[i](signer);
      const badRecipient = await factory.deploy();

      const badProof = await dispatchMessageAndReturnProof(
        helperOutbox,
        localDomain,
        utils.addressToBytes32(badRecipient.address),
        'hello world',
      );

      await expect(
        validatorManager.process(
          inbox.address,
          badProof.root,
          badProof.index,
          badProof.message,
          badProof.proof,
          badProof.index,
        ),
      ).to.be.reverted;
    });
  }

  it('Fails to process message with wrong origin Domain', async () => {
    const outboxFactory = new TestOutbox__factory(signer);
    const originOutbox = await outboxFactory.deploy(localDomain + 1);
    await originOutbox.initialize(validatorManager.address);

    const proof = await dispatchMessageAndReturnProof(
      originOutbox,
      localDomain,
      recipient,
      'hello world',
    );

    await expect(
      validatorManager.process(
        inbox.address,
        proof.root,
        proof.index,
        proof.message,
        proof.proof,
        proof.index,
      ),
    ).to.be.revertedWith('!origin');
  });

  it('Fails to process message with wrong destination Domain', async () => {
    const badProof = await dispatchMessageAndReturnProof(
      helperOutbox,
      localDomain + 1,
      recipient,
      'hello world',
    );

    await expect(
      validatorManager.process(
        inbox.address,
        badProof.root,
        badProof.index,
        badProof.message,
        badProof.proof,
        badProof.index,
      ),
    ).to.be.revertedWith('!destination');
  });

  it('Fails to process message sent to a non-existent contract address', async () => {
    const badProof = await dispatchMessageAndReturnProof(
      helperOutbox,
      localDomain,
      utils.addressToBytes32('0x1234567890123456789012345678901234567890'), // non-existent contract address
      'hello world',
    );
    await expect(
      validatorManager.process(
        inbox.address,
        badProof.root,
        badProof.index,
        badProof.message,
        badProof.proof,
        badProof.index,
      ),
    ).to.be.reverted;
  });
});
