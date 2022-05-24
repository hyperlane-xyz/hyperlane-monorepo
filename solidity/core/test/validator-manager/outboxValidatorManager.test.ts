import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import { Validator, types, utils } from '@abacus-network/utils';

import {
  OutboxValidatorManager,
  OutboxValidatorManager__factory,
  TestOutbox,
  TestOutbox__factory,
} from '../../types';

import { signCheckpoint } from './utils';

const OUTBOX_DOMAIN = 1234;
const INBOX_DOMAIN = 4321;
const QUORUM_THRESHOLD = 2;

describe('OutboxValidatorManager', () => {
  let validatorManager: OutboxValidatorManager,
    outbox: TestOutbox,
    signer: SignerWithAddress,
    validator0: Validator,
    validator1: Validator;

  before(async () => {
    const signers = await ethers.getSigners();
    signer = signers[0];
    validator0 = await Validator.fromSigner(signers[1], OUTBOX_DOMAIN);
    validator1 = await Validator.fromSigner(signers[2], OUTBOX_DOMAIN);
  });

  beforeEach(async () => {
    const validatorManagerFactory = new OutboxValidatorManager__factory(signer);
    validatorManager = await validatorManagerFactory.deploy(
      OUTBOX_DOMAIN,
      [validator0.address, validator1.address],
      QUORUM_THRESHOLD,
    );

    const outboxFactory = new TestOutbox__factory(signer);
    outbox = await outboxFactory.deploy(OUTBOX_DOMAIN);
    await outbox.initialize(validatorManager.address);
  });

  describe('#invalidCheckpoint', () => {
    // An invalid checkpoint is one that has index greater than the latest index
    // in the Outbox.
    const index = 0;
    const root = ethers.utils.formatBytes32String('test root');

    it('accepts an invalid checkpoint if it has been signed by a quorum of validators', async () => {
      const signatures = await signCheckpoint(
        root,
        index,
        [validator0, validator1], // 2/2 signers is a quorum
      );

      await expect(
        validatorManager.invalidCheckpoint(
          outbox.address,
          root,
          index,
          signatures,
        ),
      )
        .to.emit(validatorManager, 'InvalidCheckpoint')
        .withArgs(outbox.address, root, index, signatures);
      expect(await outbox.state()).to.equal(types.AbacusState.FAILED);
    });

    it('reverts if an invalid checkpoint has not been signed a quorum of validators', async () => {
      const signatures = await signCheckpoint(
        root,
        index,
        [validator0], // 1/2 signers is not a quorum
      );

      await expect(
        validatorManager.invalidCheckpoint(
          outbox.address,
          root,
          index,
          signatures,
        ),
      ).to.be.revertedWith('!quorum');
    });

    it('reverts if a valid checkpoint has been signed by a quorum of validators', async () => {
      const validIndex = 1;
      const signatures = await signCheckpoint(
        root,
        validIndex,
        [validator0, validator1], // 2/2 signers is a quorum
      );

      await expect(
        validatorManager.invalidCheckpoint(
          outbox.address,
          root,
          validIndex,
          signatures,
        ),
      ).to.be.revertedWith('!invalid');
    });
  });

  describe('#fraudulentCheckpoint', async () => {
    let actualRoot: any,
      actualLeaf: any,
      actualProof: any[32],
      fraudulentRoot: any,
      fraudulentLeaf: any,
      fraudulentProof: any[32];

    beforeEach(async () => {
      const outboxFactory = new TestOutbox__factory(signer);
      const fraudulentOutbox = await outboxFactory.deploy(OUTBOX_DOMAIN);
      await fraudulentOutbox.initialize(validatorManager.address);

      const disputedIndex = 18;
      const actualMessage = ethers.utils.formatBytes32String('message');
      const fraudulentMessage = ethers.utils.formatBytes32String('fraud');
      const recipient = utils.addressToBytes32(validator0.address);
      const destination = INBOX_DOMAIN;

      for (let i = 0; i < disputedIndex; i++) {
        await outbox.dispatch(destination, recipient, actualMessage);
        await fraudulentOutbox.dispatch(destination, recipient, actualMessage);
      }
      await outbox.dispatch(destination, recipient, actualMessage);
      await fraudulentOutbox.dispatch(
        destination,
        recipient,
        fraudulentMessage,
      );

      const formattedActualMessage = utils.formatMessage(
        OUTBOX_DOMAIN,
        signer.address,
        destination,
        recipient,
        actualMessage,
      );

      actualRoot = await outbox.root();
      console.log(actualRoot);
      actualLeaf = utils.messageHash(formattedActualMessage, disputedIndex);
      actualProof = await outbox.proof();

      const formattedFraudulentMessage = utils.formatMessage(
        OUTBOX_DOMAIN,
        signer.address,
        destination,
        recipient,
        fraudulentMessage,
      );
      fraudulentRoot = await fraudulentOutbox.root();
      fraudulentLeaf = utils.messageHash(
        formattedFraudulentMessage,
        disputedIndex,
      );
      fraudulentProof = await fraudulentOutbox.proof();
    });

    it.only('accepts a valid fraud proof if signed by quourm', async () => {
      await outbox.cacheCheckpoint();
      const signedIndex = 18;
      const signatures = await signCheckpoint(
        fraudulentRoot,
        signedIndex,
        [validator0, validator1], // 2/2 signers is a quorum
      );

      await validatorManager.fraudulentCheckpoint(
        outbox.address,
        fraudulentRoot,
        signedIndex,
        signatures,
        fraudulentLeaf,
        fraudulentProof,
        actualLeaf,
        actualProof,
        signedIndex,
      );
    });

    it('reverts if a valid fraud proof if not signed by quorum', async () => {
      // push messages A, B, C to an outbox, get proof for C
      // cache root
      // deploy another outbox, push messages X, Y, Z, get proof for Z
      // have one validator sign fraudulent root, assert failure
    });

    it('reverts if the actual root is not cached', async () => {
      // push messages A, B, C to an outbox, get proof for C
      // deploy another outbox, push messages X, Y, Z, get proof for Z
      // have one validator sign fraudulent root, assert failure
    });

    it('reverts if using an out-of-date cache', async () => {
      // push messages A, B, C to an outbox, get proof for C
      // deploy another outbox, push messages X, Y, Z, get proof for Z
      // have one validator sign fraudulent root, assert failure
    });

    it.only('returns a valid merkle proof', async () => {
      /*
      // This proof lets me prove that there is a zero-element in the tree..

      const proof = await outbox.proof();
      const root = await outbox.root();
      const count = await outbox.count();

      //const recipient = utils.addressToBytes32(validator0.address);
      //await outbox.dispatch(INBOX_DOMAIN, recipient, '0xabcdef');
      const branch = await outbox.branch();
      // Aha! Item is not branch[0]...
      const item = messageHashes[messageHashes.length - 1];
      console.log(count, root, branch, proof, item);
      const branchRoot = await outbox.branchRoot(item, proof, count.sub(1));
      expect(root).to.equal(branchRoot);
      */
    });
  });
});
