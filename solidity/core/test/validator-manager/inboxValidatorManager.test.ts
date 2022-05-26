import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import { Validator, utils } from '@abacus-network/utils';

import {
  Inbox,
  InboxValidatorManager,
  InboxValidatorManager__factory,
  Inbox__factory,
  TestOutbox,
  TestOutbox__factory,
  TestRecipient__factory,
} from '../../types';

import { signCheckpoint } from './utils';

const OUTBOX_DOMAIN = 1234;
const INBOX_DOMAIN = 4321;
const SET_SIZE = 15;
const QUORUM_THRESHOLD = 10;

describe.only('InboxValidatorManager', () => {
  let validatorManager: InboxValidatorManager,
    inbox: Inbox,
    signer: SignerWithAddress,
    validators: Validator[],
    validator0: Validator,
    validator1: Validator;

  before(async () => {
    const signers = await ethers.getSigners();
    signer = signers[0];
    validator0 = await Validator.fromSigner(signers[1], OUTBOX_DOMAIN);
    validator1 = await Validator.fromSigner(signers[2], OUTBOX_DOMAIN);
    console.log(validator1.address);
    const unsortedValidators = (
      await Promise.all(
        signers.map((signer) => Validator.fromSigner(signer, OUTBOX_DOMAIN)),
      )
    ).slice(0, SET_SIZE);
    validators = unsortedValidators.sort((a, b) => {
      // Remove the checksums for accurate comparison
      const aAddress = a.address.toLowerCase();
      const bAddress = b.address.toLowerCase();

      if (aAddress < bAddress) {
        return -1;
      } else if (aAddress > bAddress) {
        return 1;
      } else {
        return 0;
      }
    });
    console.log('validators', validators.length, 'set size', SET_SIZE);
  });

  beforeEach(async () => {
    const validatorManagerFactory = new InboxValidatorManager__factory(signer);
    validatorManager = await validatorManagerFactory.deploy(
      OUTBOX_DOMAIN,
      validators.map((v) => v.address),
      QUORUM_THRESHOLD,
    );

    const inboxFactory = new Inbox__factory(signer);
    inbox = await inboxFactory.deploy(INBOX_DOMAIN);
    await inbox.initialize(OUTBOX_DOMAIN, validatorManager.address);
  });

  const dispatchMessage = async (outbox: TestOutbox, message: string) => {
    const recipient = utils.addressToBytes32(validator0.address);
    const destination = INBOX_DOMAIN;
    await outbox.dispatch(
      destination,
      recipient,
      ethers.utils.formatBytes32String(message),
    );
  };

  const dispatchMessageAndReturnProof = async (
    outbox: TestOutbox,
    message: string,
  ) => {
    const recipient = await new TestRecipient__factory(signer).deploy();
    const destination = INBOX_DOMAIN;
    await dispatchMessage(outbox, message);
    const formattedMessage = utils.formatMessage(
      OUTBOX_DOMAIN,
      signer.address,
      destination,
      recipient.address,
      ethers.utils.formatBytes32String(message),
    );
    const count = await outbox.count();
    const leaf = utils.messageHash(formattedMessage, count.sub(1).toNumber());
    const root = await outbox.root();
    const proof = await outbox.proof();
    return {
      root,
      proof,
      leaf,
      message: formattedMessage,
      index: count.sub(1).toNumber(),
    };
  };
  describe('#process', () => {
    it('processes a message if there is a quorum', async () => {
      const outboxFactory = new TestOutbox__factory(signer);
      const outbox = await outboxFactory.deploy(OUTBOX_DOMAIN);
      await dispatchMessage(outbox, 'hello world');
      const proof = await dispatchMessageAndReturnProof(outbox, 'hello world');
      const root = await outbox.branchRoot(
        proof.leaf,
        proof.proof,
        proof.index,
      );
      const signers = validators.slice(0, QUORUM_THRESHOLD);
      const missing = validators.slice(QUORUM_THRESHOLD, SET_SIZE);
      console.log(signers.length, missing.length);
      console.log(
        validators.map((v) => v.address),
        signers.map((v) => v.address),
        missing.map((m) => m.address),
      );
      const signatures = await signCheckpoint(root, proof.index, signers);
      console.log(signatures);
      await expect(
        validatorManager.process(
          inbox.address,
          root,
          proof.index,
          signatures,
          // missing.map((m) => m.address),
          proof.message,
          proof.proof,
          proof.index,
        ),
      ).to.emit(validatorManager, 'Quorum');
    });
  });

  describe.only('#sprocess', () => {
    it('processes a message if there is a quorum', async () => {
      const outboxFactory = new TestOutbox__factory(signer);
      const outbox = await outboxFactory.deploy(OUTBOX_DOMAIN);
      await dispatchMessage(outbox, 'hello world');
      const proof = await dispatchMessageAndReturnProof(outbox, 'hello world');
      const root = await outbox.branchRoot(
        proof.leaf,
        proof.proof,
        proof.index,
      );

      // Generate and set key.
      const secretKey = await validatorManager.scalarMod(
        ethers.utils.hexlify(ethers.utils.randomBytes(32)),
      );
      const publicKey = await validatorManager.ecGen(secretKey);
      await validatorManager.setAggregateKey(publicKey);

      // Generate random nonce
      const scalarNonce = await validatorManager.scalarMod(
        ethers.utils.hexlify(ethers.utils.randomBytes(32)),
      );
      const nonce = await validatorManager.ecGen(scalarNonce);

      // Compute the challenge.
      // Do I need to do any modular arithmetic here?
      const randomness = ethers.utils.hexlify(ethers.utils.randomBytes(32));
      const domainHash = await validatorManager.domainHash();
      const digest = ethers.utils.solidityKeccak256(
        ['bytes32', 'bytes32', 'uint256'],
        [domainHash, root, proof.index],
      );
      const challenge = ethers.utils.solidityKeccak256(
        ['uint256', 'bytes32'],
        [randomness, digest],
      );

      // Compute the signature
      // This is probably wrong.
      const signature = await validatorManager.sign(
        scalarNonce,
        challenge,
        secretKey,
      );
      await expect(
        validatorManager.sprocess(
          inbox.address,
          root,
          proof.index,
          nonce,
          randomness,
          signature,
          // No public keys are missing
          [],
          proof.message,
          proof.proof,
          proof.index,
        ),
      ).to.emit(validatorManager, 'Quorum3');
    });
  });

  /*
  describe('#checkpoint', () => {
    const root = ethers.utils.formatBytes32String('test root');
    const index = 1;

    it('submits a checkpoint to the Inbox if there is a quorum', async () => {
      const signatures = await signCheckpoint(
        root,
        index,
        [validator0, validator1], // 2/2 signers, making a quorum
      );

      await validatorManager.cacheCheckpoint(
        inbox.address,
        root,
        index,
        signatures,
      );

      expect(await inbox.cachedCheckpoints(root)).to.equal(index);
    });

    it('reverts if there is not a quorum', async () => {
      const signatures = await signCheckpoint(
        root,
        index,
        [validator0], // 1/2 signers is not a quorum
      );

      await expect(
        validatorManager.cacheCheckpoint(
          inbox.address,
          root,
          index,
          signatures,
        ),
      ).to.be.revertedWith('!quorum');
    });
  });
  */
});
