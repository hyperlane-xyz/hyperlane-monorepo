import { expect } from 'chai';
import { ethers } from 'hardhat';
import { types, utils, Validator } from '@abacus-network/utils';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';

import {
  Outbox,
  Outbox__factory,
  OutboxMultisigValidatorManager,
  OutboxMultisigValidatorManager__factory,
} from '../../types';
import { signCheckpoint } from './utils';

const OUTBOX_DOMAIN = 1234;
const INBOX_DOMAIN = 4321;
const QUORUM_THRESHOLD = 2;

describe('OutboxMultisigValidatorManager', () => {
  let validatorManager: OutboxMultisigValidatorManager,
    outbox: Outbox,
    signer: SignerWithAddress,
    validator0: Validator,
    validator1: Validator;

  before(async () => {
    const signers = await ethers.getSigners();
    [signer] = signers;
    const [, validatorSigner0, validatorSigner1] = signers;
    validator0 = await Validator.fromSigner(validatorSigner0, OUTBOX_DOMAIN);
    validator1 = await Validator.fromSigner(validatorSigner1, OUTBOX_DOMAIN);
  });

  beforeEach(async () => {
    const validatorManagerFactory = new OutboxMultisigValidatorManager__factory(
      signer,
    );
    validatorManager = await validatorManagerFactory.deploy(
      OUTBOX_DOMAIN,
      [validator0.address, validator1.address],
      QUORUM_THRESHOLD,
    );

    const outboxFactory = new Outbox__factory(signer);
    outbox = await outboxFactory.deploy(OUTBOX_DOMAIN);
    await outbox.initialize(validatorManager.address);
  });

  describe('#improperCheckpoint', () => {
    const root = ethers.utils.formatBytes32String('test root');
    const index = 1;

    it('accepts an improper checkpoint if there is a quorum', async () => {
      const signatures = await signCheckpoint(
        root,
        index,
        [validator0, validator1], // 2/2 signers, making a quorum
      );

      await expect(
        validatorManager.improperCheckpoint(
          outbox.address,
          root,
          index,
          signatures,
        ),
      )
        .to.emit(validatorManager, 'ImproperCheckpoint')
        .withArgs(outbox.address, root, index, signatures);
      expect(await outbox.state()).to.equal(types.AbacusState.FAILED);
    });

    it('reverts if there is not a quorum', async () => {
      const signatures = await signCheckpoint(
        root,
        index,
        [validator0], // 1/2 signers is not a quorum
      );

      await expect(
        validatorManager.improperCheckpoint(
          outbox.address,
          root,
          index,
          signatures,
        ),
      ).to.be.revertedWith('!quorum');
    });

    it('reverts if the checkpoint is not improper', async () => {
      const message = `0x${Buffer.alloc(10).toString('hex')}`;
      await outbox.dispatch(
        INBOX_DOMAIN,
        utils.addressToBytes32(signer.address),
        message,
      );
      await outbox.checkpoint();
      const [root, index] = await outbox.latestCheckpoint();

      const signatures = await signCheckpoint(
        root,
        index.toNumber(),
        [validator0, validator1], // 2/2 signers, making a quorum
      );

      await expect(
        validatorManager.improperCheckpoint(
          outbox.address,
          root,
          index,
          signatures,
        ),
      ).to.be.revertedWith('!improper');
    });
  });
});
