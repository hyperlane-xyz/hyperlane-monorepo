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
    validator1: Validator,
    messageHashes: any[];

  before(async () => {
    const signers = await ethers.getSigners();
    signer = signers[0];
    validator0 = await Validator.fromSigner(signers[1], OUTBOX_DOMAIN);
    validator1 = await Validator.fromSigner(signers[2], OUTBOX_DOMAIN);
    messageHashes = [];
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
    // Dispatch two messages so that we can test fraudulent checkpoints.
    // Proving a checkpoint fraudulent requires a cache entry, and the Outbox
    // will only write to the cache when leaf index is > 0.
    const recipient = utils.addressToBytes32(validator0.address);
    const numMessages = 12;
    for (let i = 0; i < numMessages; i++) {
      const message = ethers.utils.formatBytes32String('message');

      const abacusMessage = utils.formatMessage(
        OUTBOX_DOMAIN,
        signer.address,
        INBOX_DOMAIN,
        recipient,
        message,
      );
      const leafIndex = await outbox.tree();
      messageHashes.push(
        utils.messageHash(abacusMessage, leafIndex.toNumber()),
      );
      await outbox.dispatch(INBOX_DOMAIN, recipient, message);
    }
  });

  describe('#invalidCheckpoint', () => {
    // An invalid checkpoint is one that has index greater than the latest index
    // in the Outbox.
    const index = 2;
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

  describe.only('#fraudulentCheckpoint', async () => {
    it('accepts a valid fraud proof if signed by quourm', async () => {
      // push messages A, B, C to an outbox, get proof for C
      // cache root
      // deploy another outbox, push messages X, Y, Z, get proof for Z
      // have validators sign fraudulent root, prove fraud
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
    });
  });
});
