import { ethers } from 'hardhat';
import { Validator } from '@abacus-network/utils';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';

import {
  Inbox,
  Inbox__factory,
  InboxMultisigValidatorManager,
  InboxMultisigValidatorManager__factory,
} from '../../types';
import { getCheckpointSignatures } from './utils';
import { expect } from 'chai';

const OUTBOX_DOMAIN = 1234;
const INBOX_DOMAIN = 4321;
const QUORUM_THRESHOLD = 2;

describe.only('InboxMultisigValidatorManager', () => {
  let validatorManager: InboxMultisigValidatorManager,
    inbox: Inbox,
    signer: SignerWithAddress,
    validator0: Validator,
    validator1: Validator;

  before(async () => {
    const signers = await ethers.getSigners();
    [signer] = signers;
    const [
      ,
      validatorSigner0,
      validatorSigner1,
    ] = signers;
    validator0 = await Validator.fromSigner(validatorSigner0, OUTBOX_DOMAIN);
    validator1 = await Validator.fromSigner(validatorSigner1, OUTBOX_DOMAIN);
  });

  beforeEach(async () => {
    const validatorManagerFactory = new InboxMultisigValidatorManager__factory(
      signer,
    );
    validatorManager = await validatorManagerFactory.deploy(
      OUTBOX_DOMAIN,
      [validator0.address, validator1.address],
      QUORUM_THRESHOLD,
    );

    const inboxFactory = new Inbox__factory(signer);
    inbox = await inboxFactory.deploy(INBOX_DOMAIN);
    await inbox.initialize(
      OUTBOX_DOMAIN,
      validatorManager.address,
      ethers.constants.HashZero,
      0,
    );
  });

  describe('#checkpoint', () => {
    const root = ethers.utils.formatBytes32String('test root');
    const index = 1;

    it('submits a checkpoint to the Inbox if there is a quorum', async () => {
      const signatures = await getCheckpointSignatures(
        root,
        index,
        [validator0, validator1], // 2/2 signers, making a quorum
      );

      await validatorManager.checkpoint(
        inbox.address,
        root,
        index,
        signatures,
      );
      
      expect(
        await inbox.checkpoints(root)
      ).to.equal(index);
    });

    it('reverts if there is not a quorum', async () => {
      const signatures = await getCheckpointSignatures(
        root,
        index,
        [validator0], // 1/2 signer is not a quorum
      );

      await expect(
        validatorManager.checkpoint(
          inbox.address,
          root,
          index,
          signatures,
        )
      ).to.be.revertedWith('!quorum');
    });
  });
});
