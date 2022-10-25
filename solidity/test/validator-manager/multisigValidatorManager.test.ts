/* eslint-disable @typescript-eslint/no-floating-promises */
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import { Validator } from '@hyperlane-xyz/utils';

import {
  TestMultisigValidatorManager,
  TestMultisigValidatorManager__factory,
} from '../../types';

import { signCheckpoint } from './utils';

const OUTBOX_DOMAIN = 1234;
const QUORUM_THRESHOLD = 1;

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const domainHashTestCases = require('../../../vectors/domainHash.json');

describe('MultisigValidatorManager', async () => {
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
    validator0 = await Validator.fromSigner(signers[2], OUTBOX_DOMAIN);
    validator1 = await Validator.fromSigner(signers[3], OUTBOX_DOMAIN);
    validator2 = await Validator.fromSigner(signers[4], OUTBOX_DOMAIN);
    validator3 = await Validator.fromSigner(signers[5], OUTBOX_DOMAIN);
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
    it('sets the domain', async () => {
      expect(await validatorManager.domain()).to.equal(OUTBOX_DOMAIN);
    });

    it('sets the domainHash', async () => {
      const domainHash = await validatorManager.getDomainHash(OUTBOX_DOMAIN);
      expect(await validatorManager.domainHash()).to.equal(domainHash);
    });

    it('enrolls the validator set', async () => {
      expect(await validatorManager.validators()).to.deep.equal([
        validator0.address,
      ]);
    });

    it('sets the quorum threshold', async () => {
      expect(await validatorManager.threshold()).to.equal([QUORUM_THRESHOLD]);
    });
  });

  describe('#enrollValidator', () => {
    it('enrolls a validator into the validator set', async () => {
      await validatorManager.enrollValidator(validator1.address);

      expect(await validatorManager.validators()).to.deep.equal([
        validator0.address,
        validator1.address,
      ]);
    });

    it('emits the EnrollValidator event', async () => {
      expect(await validatorManager.enrollValidator(validator1.address))
        .to.emit(validatorManager, 'ValidatorEnrolled')
        .withArgs(validator1.address, 2);
    });

    it('reverts if the validator is already enrolled', async () => {
      await expect(
        validatorManager.enrollValidator(validator0.address),
      ).to.be.revertedWith('already enrolled');
    });

    it('reverts when called by a non-owner', async () => {
      await expect(
        validatorManager.connect(nonOwner).enrollValidator(validator1.address),
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });
  });

  describe('#unenrollValidator', () => {
    beforeEach(async () => {
      // Enroll a second validator
      await validatorManager.enrollValidator(validator1.address);
    });

    it('unenrolls a validator from the validator set', async () => {
      await validatorManager.unenrollValidator(validator1.address);

      expect(await validatorManager.validators()).to.deep.equal([
        validator0.address,
      ]);
    });

    it('emits the UnenrollValidator event', async () => {
      expect(await validatorManager.unenrollValidator(validator1.address))
        .to.emit(validatorManager, 'ValidatorUnenrolled')
        .withArgs(validator1.address, 1);
    });

    it('reverts if the resulting validator set size will be less than the quorum threshold', async () => {
      await validatorManager.setThreshold(2);

      await expect(
        validatorManager.unenrollValidator(validator1.address),
      ).to.be.revertedWith('violates quorum threshold');
    });

    it('reverts if the validator is not already enrolled', async () => {
      await expect(
        validatorManager.unenrollValidator(validator2.address),
      ).to.be.revertedWith('!enrolled');
    });

    it('reverts when called by a non-owner', async () => {
      await expect(
        validatorManager
          .connect(nonOwner)
          .unenrollValidator(validator1.address),
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });
  });

  describe('#setThreshold', () => {
    beforeEach(async () => {
      // Have 2 validators to allow us to have more than 1 valid
      // quorum threshold
      await validatorManager.enrollValidator(validator1.address);
    });

    it('sets the quorum threshold', async () => {
      await validatorManager.setThreshold(2);

      expect(await validatorManager.threshold()).to.equal(2);
    });

    it('emits the SetThreshold event', async () => {
      expect(await validatorManager.setThreshold(2))
        .to.emit(validatorManager, 'ThresholdSet')
        .withArgs(2);
    });

    it('reverts if the new quorum threshold is zero', async () => {
      await expect(validatorManager.setThreshold(0)).to.be.revertedWith(
        '!range',
      );
    });

    it('reverts if the new quorum threshold is greater than the validator set size', async () => {
      await expect(validatorManager.setThreshold(3)).to.be.revertedWith(
        '!range',
      );
    });

    it('reverts when called by a non-owner', async () => {
      await expect(
        validatorManager.connect(nonOwner).setThreshold(2),
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });
  });

  describe('#validatorCount', () => {
    it('returns the number of validators enrolled in the validator set', async () => {
      expect(await validatorManager.validatorCount()).to.equal(1);
    });
  });

  describe('#isQuorum', () => {
    const root = ethers.utils.formatBytes32String('test root');
    const index = 1;

    beforeEach(async () => {
      // Have 3 validators and a quorum of 2
      await validatorManager.enrollValidator(validator1.address);
      await validatorManager.enrollValidator(validator2.address);

      await validatorManager.setThreshold(2);
    });

    it('returns true when there is a quorum', async () => {
      const signatures = await signCheckpoint(root, index, [
        validator0,
        validator1,
      ]);
      expect(await validatorManager.isQuorum(root, index, signatures)).to.be
        .true;
    });

    it('returns true when a quorum exists even if provided with non-validator signatures', async () => {
      const signatures = await signCheckpoint(
        root,
        index,
        [validator0, validator1, validator3], // validator 3 is not enrolled
      );
      expect(await validatorManager.isQuorum(root, index, signatures)).to.be
        .true;
    });

    it('returns false when the signature count is less than the quorum threshold', async () => {
      const signatures = await signCheckpoint(root, index, [validator0]);
      expect(await validatorManager.isQuorum(root, index, signatures)).to.be
        .false;
    });

    it('returns false when some signatures are not from enrolled validators', async () => {
      const signatures = await signCheckpoint(
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
        await signCheckpoint(root, index, [validator0, validator1])
      ).reverse();

      await expect(
        validatorManager.isQuorum(root, index, signatures),
      ).to.be.revertedWith('!sorted signers');
    });
  });

  describe('#isValidator', () => {
    it('returns true if an address is enrolled in the validator set', async () => {
      expect(await validatorManager.isValidator(validator0.address)).to.be.true;
    });

    it('returns false if an address is not enrolled in the validator set', async () => {
      expect(await validatorManager.isValidator(validator1.address)).to.be
        .false;
    });
  });

  describe('#_domainHash', () => {
    it('matches Rust-produced domain hashes', async () => {
      // Compare Rust output in json file to solidity output (json file matches
      // hash for local domain of 1000)
      for (const testCase of domainHashTestCases) {
        const { expectedDomainHash } = testCase;
        // This public function on TestMultisigValidatorManager exposes
        // the internal _domainHash on MultisigValidatorManager.
        const domainHash = await validatorManager.getDomainHash(
          testCase.outboxDomain,
        );
        expect(domainHash).to.equal(expectedDomainHash);
      }
    });
  });
});
