import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { ethers } from 'hardhat';

import { Validator, types, utils } from '@abacus-network/utils';

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
const THRESHOLD = 8;
const SET_SIZE = 32;

describe.only('InboxValidatorManager', () => {
  let validatorManager: InboxValidatorManager,
    inbox: Inbox,
    signer: SignerWithAddress,
    validators: ValidatorSet,
    recipient: string;

  before(async () => {
    const signers = await ethers.getSigners();
    signer = signers[0];
  });

  beforeEach(async () => {
    // Deploy contracts
    const validatorManagerFactory = new InboxValidatorManager__factory(signer);
    validatorManager = await validatorManagerFactory.deploy();

    const inboxFactory = new Inbox__factory(signer);
    inbox = await inboxFactory.deploy(INBOX_DOMAIN);
    await inbox.initialize(OUTBOX_DOMAIN, validatorManager.address);

    // Create and enroll validators
    validators = new ValidatorSet(SET_SIZE, validatorManager);
    await validators.enroll(OUTBOX_DOMAIN);

    // Set up test message recipient
    recipient = utils.addressToBytes32(
      (await new TestRecipient__factory(signer).deploy()).address,
    );
  });

  const dispatchMessage = async (outbox: TestOutbox, message: string) => {
    return dispatchMessageAndReturnProof(
      outbox,
      INBOX_DOMAIN,
      recipient,
      message,
    );
  };

  describe('#process', () => {
    it('processes a message if there is a quorum', async () => {
      const outboxFactory = new TestOutbox__factory(signer);
      const outbox = await outboxFactory.deploy(OUTBOX_DOMAIN);
      const MESSAGES = 32;
      const MESSAGE_WORDS = 1;
      for (let i = 0; i < MESSAGES; i++) {
        const proof = await dispatchMessage(
          outbox,
          ethers.utils.hexlify(ethers.utils.randomBytes(MESSAGE_WORDS * 32)),
        );
        const signature = await validators.sign(proof.checkpoint);
        await expect(
          validatorManager.process(
            inbox.address,
            proof.checkpoint,
            signature.randomness,
            signature.signature,
            signature.nonce,
            signature.missing,
            proof.message,
            proof.proof,
            proof.checkpoint.index,
          ),
        ).to.emit(validatorManager, 'Quorum');
        if (i % 10 == 0) {
          console.log(i);
        }
      }
    });
  });

  describe.only('#batchProcess', () => {
    it('processes a message if there is a quorum', async () => {
      const outboxFactory = new TestOutbox__factory(signer);
      const outbox = await outboxFactory.deploy(OUTBOX_DOMAIN);
      const MESSAGES = 100;
      const MESSAGE_WORDS = 1;
      const proofs = [];
      for (let i = 0; i < MESSAGES; i++) {
        const message = ethers.utils.hexlify(
          ethers.utils.randomBytes(MESSAGE_WORDS * 32),
        );
        console.log(message);
        proofs.push(await dispatchMessage(outbox, message));
      }
      const latest = proofs[proofs.length - 1];
      const signature = await validators.sign(latest.checkpoint);
      await expect(
        validatorManager.batchProcess(
          inbox.address,
          latest.checkpoint,
          [signature.randomness, signature.signature],
          signature.nonce,
          signature.missing,
          proofs.map((p) => p.message),
          proofs.map((p) => p.proof),
          proofs.map((p) => p.checkpoint.index),
        ),
      ).to.emit(validatorManager, 'Quorum');
    });
  });
});
