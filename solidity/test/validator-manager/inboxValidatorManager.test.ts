import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import { Validator, types, utils } from '@hyperlane-xyz/utils';

import {
  Inbox,
  InboxValidatorManager,
  InboxValidatorManager__factory,
  Inbox__factory,
  TestOutbox__factory,
  TestRecipient__factory,
} from '../../types';
import { MerkleProof, dispatchMessageAndReturnProof } from '../lib/mailboxes';

import { signCheckpoint } from './utils';

const OUTBOX_DOMAIN = 1234;
const INBOX_DOMAIN = 4321;
const QUORUM_THRESHOLD = 2;

describe('InboxValidatorManager', () => {
  let validatorManager: InboxValidatorManager,
    inbox: Inbox,
    signer: SignerWithAddress,
    proof: MerkleProof,
    validator0: Validator,
    validator1: Validator;

  before(async () => {
    const signers = await ethers.getSigners();
    signer = signers[0];
    validator0 = await Validator.fromSigner(signers[1], OUTBOX_DOMAIN);
    validator1 = await Validator.fromSigner(signers[2], OUTBOX_DOMAIN);
  });

  beforeEach(async () => {
    const validatorManagerFactory = new InboxValidatorManager__factory(signer);
    validatorManager = await validatorManagerFactory.deploy(
      OUTBOX_DOMAIN,
      [validator0.address, validator1.address],
      QUORUM_THRESHOLD,
    );

    const inboxFactory = new Inbox__factory(signer);
    inbox = await inboxFactory.deploy(INBOX_DOMAIN);
    await inbox.initialize(OUTBOX_DOMAIN, validatorManager.address);

    // Deploy a helper outbox contract so that we can easily construct merkle
    // proofs.
    const outboxFactory = new TestOutbox__factory(signer);
    const helperOutbox = await outboxFactory.deploy(OUTBOX_DOMAIN);
    await helperOutbox.initialize(validatorManager.address);
    const recipientF = await new TestRecipient__factory(signer).deploy();
    const recipient = utils.addressToBytes32(recipientF.address);
    proof = await dispatchMessageAndReturnProof(
      helperOutbox,
      INBOX_DOMAIN,
      recipient,
      'hello world',
    );
  });

  describe('#process', () => {
    it('processes a message on the Inbox if there is a quorum', async () => {
      const signatures = await signCheckpoint(
        proof.root,
        proof.index,
        [validator0, validator1], // 2/2 signers, making a quorum
      );

      await validatorManager.process(
        inbox.address,
        proof.root,
        proof.index,
        signatures,
        proof.message,
        proof.proof,
        proof.index,
      );
      expect(await inbox.messages(proof.leaf)).to.eql(
        types.MessageStatus.PROCESSED,
      );
    });

    it('reverts if there is not a quorum', async () => {
      const signatures = await signCheckpoint(
        proof.root,
        proof.index,
        [validator0], // 1/2 signers is not a quorum
      );

      await expect(
        validatorManager.process(
          inbox.address,
          proof.root,
          proof.index,
          signatures,
          proof.message,
          proof.proof,
          proof.index,
        ),
      ).to.be.revertedWith('!quorum');
    });
  });
});
