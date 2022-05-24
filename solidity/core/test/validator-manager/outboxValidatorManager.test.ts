import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import { Validator, types, utils } from '@abacus-network/utils';

import {
  Outbox,
  OutboxValidatorManager,
  OutboxValidatorManager__factory,
  Outbox__factory,
} from '../../types';

import { signCheckpoint } from './utils';

const OUTBOX_DOMAIN = 1234;
const INBOX_DOMAIN = 4321;
const QUORUM_THRESHOLD = 2;

describe('OutboxValidatorManager', () => {
  let validatorManager: OutboxValidatorManager,
    outbox: Outbox,
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

    const outboxFactory = new Outbox__factory(signer);
    outbox = await outboxFactory.deploy(OUTBOX_DOMAIN);
    await outbox.initialize(validatorManager.address);
    // Dispatch two messages so that we can test fraudulent checkpoints.
    // Proving a checkpoint fraudulent requires a cache entry, and the Outbox
    // will only write to the cache when leaf index is > 0.
    const recipient = utils.addressToBytes32(validator0.address);
    await outbox.dispatch(INBOX_DOMAIN, recipient, '0xabcdef');
    await outbox.dispatch(INBOX_DOMAIN, recipient, '0xabcdef');
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

  // TODO
  describe('#fraudulentCheckpoint', () => {});
});
