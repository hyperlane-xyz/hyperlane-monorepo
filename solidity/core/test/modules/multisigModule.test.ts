/* eslint-disable @typescript-eslint/no-floating-promises */
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import { Validator } from '@hyperlane-xyz/utils';

import {
  TestMailbox,
  TestMailbox__factory,
  TestMultisigModule,
  TestMultisigModule__factory,
} from '../../types';
import {
  dispatchMessageAndReturnMetadata,
  getCommitment,
} from '../lib/mailboxes';

const ORIGIN_DOMAIN = 1234;
const DESTINATION_DOMAIN = 4321;
// const QUORUM_THRESHOLD = 1;

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
// const domainHashTestCases = require('../../../../vectors/domainHash.json');

describe.only('MultisigModule', async () => {
  let multisigModule: TestMultisigModule,
    mailbox: TestMailbox,
    signer: SignerWithAddress,
    nonOwner: SignerWithAddress,
    validator0: Validator,
    validator1: Validator,
    validator2: Validator;
  // validator3: Validator;

  before(async () => {
    const signers = await ethers.getSigners();
    [signer, nonOwner] = signers;
    const version = 0;
    const mailboxFactory = new TestMailbox__factory(signer);
    mailbox = await mailboxFactory.deploy(ORIGIN_DOMAIN, version);
    validator0 = await Validator.fromSigner(
      signers[2],
      ORIGIN_DOMAIN,
      mailbox.address,
    );
    validator1 = await Validator.fromSigner(
      signers[3],
      ORIGIN_DOMAIN,
      mailbox.address,
    );
    validator2 = await Validator.fromSigner(
      signers[4],
      ORIGIN_DOMAIN,
      mailbox.address,
    );
    /*
    validator3 = await Validator.fromSigner(
      signers[5],
      ORIGIN_DOMAIN,
      mailbox.address,
    );
    */
  });

  beforeEach(async () => {
    const multisigModuleFactory = new TestMultisigModule__factory(signer);
    multisigModule = await multisigModuleFactory.deploy();
    // Enroll a single validator for testing purposes
    await multisigModule.enrollValidator(ORIGIN_DOMAIN, validator0.address);
    await multisigModule.setThreshold(ORIGIN_DOMAIN, 1);
  });

  describe('#constructor', () => {
    it('sets the owner', async () => {
      expect(await multisigModule.owner()).to.equal(signer.address);
    });
  });

  // TODO: Verify commitment in event
  describe('#enrollValidator', () => {
    it('enrolls a validator into the validator set', async () => {
      await multisigModule.enrollValidator(ORIGIN_DOMAIN, validator1.address);

      expect(await multisigModule.validators(ORIGIN_DOMAIN)).to.deep.equal([
        validator0.address,
        validator1.address,
      ]);
    });

    it('emits the ValidatorEnrolled event', async () => {
      const expectedCommitment = getCommitment(1, [
        validator0.address,
        validator1.address,
      ]);
      expect(
        await multisigModule.enrollValidator(ORIGIN_DOMAIN, validator1.address),
      )
        .to.emit(multisigModule, 'ValidatorEnrolled')
        .withArgs(ORIGIN_DOMAIN, validator1.address, 2, expectedCommitment);
    });

    it('reverts if the validator is already enrolled', async () => {
      await expect(
        multisigModule.enrollValidator(ORIGIN_DOMAIN, validator0.address),
      ).to.be.revertedWith('already enrolled');
    });

    it('reverts when called by a non-owner', async () => {
      await expect(
        multisigModule
          .connect(nonOwner)
          .enrollValidator(ORIGIN_DOMAIN, validator1.address),
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });
  });

  describe('#unenrollValidator', () => {
    beforeEach(async () => {
      // Enroll a second validator
      await multisigModule.enrollValidator(ORIGIN_DOMAIN, validator1.address);
    });

    it('unenrolls a validator from the validator set', async () => {
      await multisigModule.unenrollValidator(ORIGIN_DOMAIN, validator1.address);

      expect(await multisigModule.validators(ORIGIN_DOMAIN)).to.deep.equal([
        validator0.address,
      ]);
    });

    it('emits the ValidatorUnenrolled event', async () => {
      const expectedCommitment = getCommitment(1, [validator0.address]);
      expect(
        await multisigModule.unenrollValidator(
          ORIGIN_DOMAIN,
          validator1.address,
        ),
      )
        .to.emit(multisigModule, 'ValidatorUnenrolled')
        .withArgs(ORIGIN_DOMAIN, validator1.address, 1, expectedCommitment);
    });

    it('reverts if the resulting validator set size will be less than the quorum threshold', async () => {
      await multisigModule.setThreshold(ORIGIN_DOMAIN, 2);

      await expect(
        multisigModule.unenrollValidator(ORIGIN_DOMAIN, validator1.address),
      ).to.be.revertedWith('violates quorum threshold');
    });

    it('reverts if the validator is not already enrolled', async () => {
      await expect(
        multisigModule.unenrollValidator(ORIGIN_DOMAIN, validator2.address),
      ).to.be.revertedWith('!enrolled');
    });

    it('reverts when called by a non-owner', async () => {
      await expect(
        multisigModule
          .connect(nonOwner)
          .unenrollValidator(ORIGIN_DOMAIN, validator1.address),
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });
  });

  describe('#setThreshold', () => {
    beforeEach(async () => {
      // Have 2 validators to allow us to have more than 1 valid
      // quorum threshold
      await multisigModule.enrollValidator(ORIGIN_DOMAIN, validator1.address);
    });

    it('sets the quorum threshold', async () => {
      await multisigModule.setThreshold(ORIGIN_DOMAIN, 2);

      expect(await multisigModule.threshold(ORIGIN_DOMAIN)).to.equal(2);
    });

    it('emits the SetThreshold event', async () => {
      const expectedCommitment = getCommitment(2, [
        validator0.address,
        validator1.address,
      ]);
      expect(await multisigModule.setThreshold(ORIGIN_DOMAIN, 2))
        .to.emit(multisigModule, 'ThresholdSet')
        .withArgs(ORIGIN_DOMAIN, 2, expectedCommitment);
    });

    it('reverts if the new quorum threshold is zero', async () => {
      await expect(
        multisigModule.setThreshold(ORIGIN_DOMAIN, 0),
      ).to.be.revertedWith('!range');
    });

    it('reverts if the new quorum threshold is greater than the validator set size', async () => {
      await expect(
        multisigModule.setThreshold(ORIGIN_DOMAIN, 3),
      ).to.be.revertedWith('!range');
    });

    it('reverts when called by a non-owner', async () => {
      await expect(
        multisigModule.connect(nonOwner).setThreshold(ORIGIN_DOMAIN, 2),
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });
  });

  describe('#validatorCount', () => {
    it('returns the number of validators enrolled in the validator set', async () => {
      expect(await multisigModule.validatorCount(ORIGIN_DOMAIN)).to.equal(1);
    });
  });

  describe('#verify', () => {
    let metadata: string, message: string;
    beforeEach(async () => {
      await multisigModule.enrollValidator(ORIGIN_DOMAIN, validator1.address);
      await multisigModule.setThreshold(ORIGIN_DOMAIN, 2);
    });

    before(async () => {
      const validators = [validator0, validator1];
      const recipient = '0x1234567890123456789012345678901234567890'; // random address
      ({ message, metadata } = await dispatchMessageAndReturnMetadata(
        mailbox,
        DESTINATION_DOMAIN,
        recipient,
        'hello world',
        validators,
      ));
    });

    it('returns true when valid metadata is provided', async () => {
      expect(await multisigModule.verify(metadata, message)).to.be.true;
    });

    describe('#verifyMerkleProof', () => {
      it('returns true when a valid proof is provided', async () => {
        expect(await multisigModule.verifyMerkleProof(metadata, message)).to.be
          .true;
      });
    });

    describe('#verifyValidatorSignatures', () => {
      it('returns true when valid signatures are provided', async () => {
        expect(
          await multisigModule.verifyValidatorSignatures(metadata, message),
        ).to.be.true;
      });
    });
  });

  /*
  describe.skip('#isQuorum', () => {
    const root = ethers.utils.formatBytes32String('test root');
    const index = 1;

    beforeEach(async () => {
      // Have 3 validators and a quorum of 2
      await multisigModule.enrollValidator(ORIGIN_DOMAIN, validator1.address);
      await multisigModule.enrollValidator(ORIGIN_DOMAIN, validator2.address);

      await multisigModule.setThreshold(ORIGIN_DOMAIN, 2);
    });

    it('returns true when there is a quorum', async () => {
      const signatures = await signCheckpoint(root, index, [
        validator0,
        validator1,
      ]);
      expect(await multisigModule.isQuorum(root, index, signatures)).to.be.true;
    });

    it('returns true when a quorum exists even if provided with non-validator signatures', async () => {
      const signatures = await signCheckpoint(
        root,
        index,
        [validator0, validator1, validator3], // validator 3 is not enrolled
      );
      expect(await multisigModule.isQuorum(root, index, signatures)).to.be.true;
    });

    it('returns false when the signature count is less than the quorum threshold', async () => {
      const signatures = await signCheckpoint(root, index, [validator0]);
      expect(await multisigModule.isQuorum(root, index, signatures)).to.be
        .false;
    });

    it('returns false when some signatures are not from enrolled validators', async () => {
      const signatures = await signCheckpoint(
        root,
        index,
        [validator0, validator3], // validator 3 is not enrolled
      );
      expect(await multisigModule.isQuorum(root, index, signatures)).to.be
        .false;
    });

    it('reverts when signatures are not ordered by their signer', async () => {
      // Reverse the signature order, purposely messing up the
      // ascending sort
      const signatures = (
        await signCheckpoint(root, index, [validator0, validator1])
      ).reverse();

      await expect(
        multisigModule.isQuorum(root, index, signatures),
      ).to.be.revertedWith('!sorted signers');
    });
  });

  describe('#isValidator', () => {
    it('returns true if an address is enrolled in the validator set', async () => {
      expect(await multisigModule.isValidator(validator0.address)).to.be.true;
    });

    it('returns false if an address is not enrolled in the validator set', async () => {
      expect(await multisigModule.isValidator(validator1.address)).to.be.false;
    });
  });

  describe.skip('#_domainHash', () => {
    it('matches Rust-produced domain hashes', async () => {
      // Compare Rust output in json file to solidity output (json file matches
      // hash for local domain of 1000)
      for (const testCase of domainHashTestCases) {
        const { expectedDomainHash } = testCase;
        // This public function on MultisigValidatorManager exposes
        // the internal _domainHash on MultisigValidatorManager.
        const domainHash = await multisigModule.getDomainHash(
          testCase.outboxDomain,
        );
        expect(domainHash).to.equal(expectedDomainHash);
      }
    });
  });
  */
});
