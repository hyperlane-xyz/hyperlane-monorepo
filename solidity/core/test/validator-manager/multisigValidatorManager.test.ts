import { ethers } from 'hardhat';
import { expect } from 'chai';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { Validator } from '@abacus-network/utils';

import {
  TestMultisigValidatorManager,
  TestMultisigValidatorManager__factory,
} from '../../types';
import { getCheckpointSignatures } from './utils';

const OUTBOX_DOMAIN = 1234;
const OUTBOX_DOMAIN_HASH = ethers.utils.keccak256(
  ethers.utils.solidityPack(['uint32', 'string'], [OUTBOX_DOMAIN, 'ABACUS']),
);
const QUORUM_THRESHOLD = 1;

describe.only('MultisigValidatorManager', async () => {
  let validatorManager: TestMultisigValidatorManager,
    signer: SignerWithAddress,
    nonOwner: SignerWithAddress,
    validator0: Validator,
    validator1: Validator,
    validator2: Validator,
    validator3: Validator;

  before(async () => {
    const signers = await ethers.getSigners();
    [signer, nonOwner] = signers;
    const [
      ,
      ,
      validatorSigner0,
      validatorSigner1,
      validatorSigner2,
      validatorSigner3,
    ] = signers;
    validator0 = await Validator.fromSigner(validatorSigner0, OUTBOX_DOMAIN);
    validator1 = await Validator.fromSigner(validatorSigner1, OUTBOX_DOMAIN);
    validator2 = await Validator.fromSigner(validatorSigner2, OUTBOX_DOMAIN);
    validator3 = await Validator.fromSigner(validatorSigner3, OUTBOX_DOMAIN);
  });

  beforeEach(async () => {
    const validatorManagerFactory = new TestMultisigValidatorManager__factory(
      signer,
    );
    validatorManager = await validatorManagerFactory.deploy(
      OUTBOX_DOMAIN,
      [validator0.address],
      QUORUM_THRESHOLD,
    );
  });

  describe('#constructor', () => {
    it('sets the outboxDomain', async () => {
      expect(await validatorManager.outboxDomain()).to.equal(OUTBOX_DOMAIN);
    });

    it('sets the outboxDomainHash', async () => {
      expect(await validatorManager.outboxDomainHash()).to.equal(
        OUTBOX_DOMAIN_HASH,
      );
    });

    it('enrolls the validator set', async () => {
      expect(await validatorManager.validatorSet()).to.deep.equal([
        validator0.address,
      ]);
    });

    it('sets the quorum threshold', async () => {
      expect(await validatorManager.quorumThreshold()).to.equal([
        QUORUM_THRESHOLD,
      ]);
    });
  });

  describe('#enrollValidator', () => {
    it('enrolls a validator into the validator set', async () => {
      await validatorManager.enrollValidator(validator1.address);

      expect(await validatorManager.validatorSet()).to.deep.equal([
        validator0.address,
        validator1.address,
      ]);
    });

    it('emits the EnrollValidator event', async () => {
      expect(await validatorManager.enrollValidator(validator1.address))
        .to.emit(validatorManager, 'EnrollValidator')
        .withArgs(validator1.address);
    });

    it('reverts if the validator is already enrolled', async () => {
      await expect(
        validatorManager.enrollValidator(validator0.address),
      ).to.be.revertedWith('enrolled');
    });

    it('reverts when called by a non-owner', async () => {
      await expect(
        validatorManager.connect(nonOwner).enrollValidator(validator1.address),
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });
  });

  describe('#unenrollValidator', () => {
    it('unenrolls a validator from the validator set', async () => {
      await validatorManager.unenrollValidator(validator0.address);

      expect(await validatorManager.validatorSet()).to.deep.equal([]);
    });

    it('emits the UnenrollValidator event', async () => {
      expect(await validatorManager.unenrollValidator(validator0.address))
        .to.emit(validatorManager, 'UnenrollValidator')
        .withArgs(validator0.address);
    });

    it('reverts if the validator is not already enrolled', async () => {
      await expect(
        validatorManager.unenrollValidator(validator1.address),
      ).to.be.revertedWith('!enrolled');
    });

    it('reverts when called by a non-owner', async () => {
      await expect(
        validatorManager
          .connect(nonOwner)
          .unenrollValidator(validator0.address),
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });
  });

  describe('#setQuorumThreshold', () => {
    beforeEach(async () => {
      // Have 2 validators to allow us to have more than 1 valid
      // quorum threshold
      await validatorManager.enrollValidator(validator1.address);
    });

    it('sets the quorum threshold', async () => {
      await validatorManager.setQuorumThreshold(2);

      expect(await validatorManager.quorumThreshold()).to.equal(2);
    });

    it('emits the SetQuorumThreshold event', async () => {
      expect(await validatorManager.setQuorumThreshold(2))
        .to.emit(validatorManager, 'SetQuorumThreshold')
        .withArgs(2);
    });

    it('reverts if the new quorum threshold is zero', async () => {
      await expect(validatorManager.setQuorumThreshold(0)).to.be.revertedWith(
        '!range',
      );
    });

    it('reverts if the new quorum threshold is > the validator set size', async () => {
      await expect(validatorManager.setQuorumThreshold(3)).to.be.revertedWith(
        '!range',
      );
    });

    it('reverts when called by a non-owner', async () => {
      await expect(
        validatorManager.connect(nonOwner).setQuorumThreshold(2),
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });
  });

  describe('#isQuorum', () => {
    const root = ethers.utils.formatBytes32String('test root');
    const index = 1;

    beforeEach(async () => {
      // Have 3 validators and a quorum of 2
      await validatorManager.enrollValidator(validator1.address);
      await validatorManager.enrollValidator(validator2.address);

      await validatorManager.setQuorumThreshold(2);
    });

    it('returns true when there is a quorum', async () => {
      const signatures = await getCheckpointSignatures(root, index, [
        validator0,
        validator1,
      ]);
      expect(await validatorManager.isQuorum(root, index, signatures)).to.be
        .true;
    });

    it('returns true when a quorum exists even if provided with non-validator signatures', async () => {
      const signatures = await getCheckpointSignatures(
        root,
        index,
        [validator0, validator1, validator3], // validator 3 is not enrolled
      );
      expect(await validatorManager.isQuorum(root, index, signatures)).to.be
        .true;
    });

    it('returns false when the signature count is < the quorum threshold', async () => {
      const signatures = await getCheckpointSignatures(root, index, [
        validator0,
      ]);
      expect(await validatorManager.isQuorum(root, index, signatures)).to.be
        .false;
    });

    it('returns false when some signatures are not from enrolled validators', async () => {
      const signatures = await getCheckpointSignatures(
        root,
        index,
        [validator0, validator3], // validator 3 is not enrolled
      );
      expect(await validatorManager.isQuorum(root, index, signatures)).to.be
        .false;
    });

    it('reverts when signatures are not ordered by their signer', async () => {
      // Reverse the signature order, purposely messing up the
      // ascending sort
      const signatures = (
        await getCheckpointSignatures(root, index, [validator0, validator1])
      ).reverse();

      await expect(
        validatorManager.isQuorum(root, index, signatures),
      ).to.be.revertedWith('!sorted signers');
    });
  });
});
