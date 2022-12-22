/* eslint-disable @typescript-eslint/no-floating-promises */
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import { Validator, types, utils } from '@hyperlane-xyz/utils';

import {
  TestMailbox,
  TestMailbox__factory,
  TestMultisigIsm,
  TestMultisigIsm__factory,
  TestRecipient__factory,
} from '../../types';
import {
  dispatchMessage,
  dispatchMessageAndReturnMetadata,
  getCommitment,
  signCheckpoint,
} from '../lib/mailboxes';

const ORIGIN_DOMAIN = 1234;
const DESTINATION_DOMAIN = 4321;

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const domainHashTestCases = require('../../../vectors/domainHash.json');

describe('MultisigIsm', async () => {
  let multisigIsm: TestMultisigIsm,
    mailbox: TestMailbox,
    signer: SignerWithAddress,
    nonOwner: SignerWithAddress,
    validators: Validator[];

  before(async () => {
    const signers = await ethers.getSigners();
    [signer, nonOwner] = signers;
    const mailboxFactory = new TestMailbox__factory(signer);
    mailbox = await mailboxFactory.deploy(ORIGIN_DOMAIN);
    validators = await Promise.all(
      signers
        .filter((_, i) => i > 1)
        .map((s) => Validator.fromSigner(s, ORIGIN_DOMAIN, mailbox.address)),
    );
  });

  beforeEach(async () => {
    const multisigIsmFactory = new TestMultisigIsm__factory(signer);
    multisigIsm = await multisigIsmFactory.deploy();
  });

  describe('#constructor', () => {
    it('sets the owner', async () => {
      expect(await multisigIsm.owner()).to.equal(signer.address);
    });
  });

  describe('#moduleType', () => {
    it('returns the correct type', async () => {
      expect(await multisigIsm.moduleType()).to.equal(
        types.InterchainSecurityModuleType.MULTISIG,
      );
    });
  });

  describe('#enrollValidators', () => {
    let validatorAddresses: string[];
    const domains = [ORIGIN_DOMAIN, DESTINATION_DOMAIN];
    before(async () => {
      validatorAddresses = validators.map((v) => v.address);
    });

    it('enrolls validators into multiple validator sets', async () => {
      await multisigIsm.enrollValidators(
        domains,
        domains.map(() => validatorAddresses),
      );

      await Promise.all(
        domains.map(async (domain) => {
          expect(await multisigIsm.validators(domain)).to.deep.equal(
            validatorAddresses,
          );
        }),
      );
    });

    it('emits the ValidatorEnrolled event', async () => {
      expect(
        await multisigIsm.enrollValidators(
          domains,
          domains.map(() => validatorAddresses),
        ),
      )
        .to.emit(multisigIsm, 'ValidatorEnrolled')
        .withArgs(ORIGIN_DOMAIN, validatorAddresses[0], 1);
    });

    it('emits the CommitmentUpdated event', async () => {
      const expectedCommitment = getCommitment(0, validatorAddresses);
      expect(
        await multisigIsm.enrollValidators(
          domains,
          domains.map(() => validatorAddresses),
        ),
      )
        .to.emit(multisigIsm, 'CommitmentUpdated')
        .withArgs(ORIGIN_DOMAIN, expectedCommitment);
    });

    it('reverts when called by a non-owner', async () => {
      await expect(
        multisigIsm.connect(nonOwner).enrollValidators(
          domains,
          domains.map(() => validatorAddresses),
        ),
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });
  });

  describe('#enrollValidator', () => {
    it('enrolls a validator into the validator set', async () => {
      await multisigIsm.enrollValidator(ORIGIN_DOMAIN, validators[0].address);

      expect(await multisigIsm.validators(ORIGIN_DOMAIN)).to.deep.equal([
        validators[0].address,
      ]);
    });

    it('emits the ValidatorEnrolled event', async () => {
      expect(
        await multisigIsm.enrollValidator(ORIGIN_DOMAIN, validators[0].address),
      )
        .to.emit(multisigIsm, 'ValidatorEnrolled')
        .withArgs(ORIGIN_DOMAIN, validators[0].address, 1);
    });

    it('emits the CommitmentUpdated event', async () => {
      const expectedCommitment = getCommitment(0, [validators[0].address]);
      expect(
        await multisigIsm.enrollValidator(ORIGIN_DOMAIN, validators[0].address),
      )
        .to.emit(multisigIsm, 'CommitmentUpdated')
        .withArgs(ORIGIN_DOMAIN, expectedCommitment);
    });

    it('reverts if the validator is already enrolled', async () => {
      await multisigIsm.enrollValidator(ORIGIN_DOMAIN, validators[0].address);
      await expect(
        multisigIsm.enrollValidator(ORIGIN_DOMAIN, validators[0].address),
      ).to.be.revertedWith('already enrolled');
    });

    it('reverts when called by a non-owner', async () => {
      await expect(
        multisigIsm
          .connect(nonOwner)
          .enrollValidator(ORIGIN_DOMAIN, validators[0].address),
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });
  });

  describe('#unenrollValidator', () => {
    beforeEach(async () => {
      await multisigIsm.enrollValidator(ORIGIN_DOMAIN, validators[0].address);
    });

    it('unenrolls a validator from the validator set', async () => {
      await multisigIsm.unenrollValidator(ORIGIN_DOMAIN, validators[0].address);

      expect(await multisigIsm.validators(ORIGIN_DOMAIN)).to.deep.equal([]);
    });

    it('emits the ValidatorUnenrolled event', async () => {
      expect(
        await multisigIsm.unenrollValidator(
          ORIGIN_DOMAIN,
          validators[0].address,
        ),
      )
        .to.emit(multisigIsm, 'ValidatorUnenrolled')
        .withArgs(ORIGIN_DOMAIN, validators[0].address, 0);
    });

    it('emits the CommitmentUpdated event', async () => {
      const expectedCommitment = getCommitment(0, []);
      expect(
        await multisigIsm.unenrollValidator(
          ORIGIN_DOMAIN,
          validators[0].address,
        ),
      )
        .to.emit(multisigIsm, 'CommitmentUpdated')
        .withArgs(ORIGIN_DOMAIN, expectedCommitment);
    });

    it('reverts if the resulting validator set size will be less than the quorum threshold', async () => {
      await multisigIsm.setThreshold(ORIGIN_DOMAIN, 1);

      await expect(
        multisigIsm.unenrollValidator(ORIGIN_DOMAIN, validators[0].address),
      ).to.be.revertedWith('violates quorum threshold');
    });

    it('reverts if the validator is not already enrolled', async () => {
      await expect(
        multisigIsm.unenrollValidator(ORIGIN_DOMAIN, validators[1].address),
      ).to.be.revertedWith('!enrolled');
    });

    it('reverts when called by a non-owner', async () => {
      await expect(
        multisigIsm
          .connect(nonOwner)
          .unenrollValidator(ORIGIN_DOMAIN, validators[0].address),
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });
  });

  describe('#setThresholds', () => {
    let validatorAddresses: string[];
    const domains = [ORIGIN_DOMAIN, DESTINATION_DOMAIN];
    const thresholds = [2, 4];
    before(async () => {
      validatorAddresses = validators.map((v) => v.address);
    });

    beforeEach(async () => {
      await multisigIsm.enrollValidators(
        domains,
        domains.map(() => validatorAddresses),
      );
    });

    it('sets the quorum thresholds', async () => {
      await multisigIsm.setThresholds(domains, thresholds);

      await Promise.all(
        domains.map(async (domain, i) => {
          expect(await multisigIsm.threshold(domain)).to.equal(thresholds[i]);
        }),
      );
    });

    it('emits the SetThreshold event', async () => {
      expect(await multisigIsm.setThresholds(domains, thresholds))
        .to.emit(multisigIsm, 'ThresholdSet')
        .withArgs(ORIGIN_DOMAIN, 2);
    });

    it('emits the CommitmentUpdated event', async () => {
      const expectedCommitment = getCommitment(2, validatorAddresses);
      expect(await multisigIsm.setThresholds(domains, thresholds))
        .to.emit(multisigIsm, 'CommitmentUpdated')
        .withArgs(ORIGIN_DOMAIN, expectedCommitment);
    });

    it('reverts when called by a non-owner', async () => {
      await expect(
        multisigIsm.connect(nonOwner).setThresholds(domains, thresholds),
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });
  });

  describe('#setThreshold', () => {
    beforeEach(async () => {
      // Have 2 validators to allow us to have more than 1 valid
      // quorum threshold
      await multisigIsm.enrollValidator(ORIGIN_DOMAIN, validators[0].address);
      await multisigIsm.enrollValidator(ORIGIN_DOMAIN, validators[1].address);
    });

    it('sets the quorum threshold', async () => {
      await multisigIsm.setThreshold(ORIGIN_DOMAIN, 2);

      expect(await multisigIsm.threshold(ORIGIN_DOMAIN)).to.equal(2);
    });

    it('emits the SetThreshold event', async () => {
      expect(await multisigIsm.setThreshold(ORIGIN_DOMAIN, 2))
        .to.emit(multisigIsm, 'ThresholdSet')
        .withArgs(ORIGIN_DOMAIN, 2);
    });

    it('emits the CommitmentUpdated event', async () => {
      const expectedCommitment = getCommitment(2, [
        validators[0].address,
        validators[1].address,
      ]);
      expect(await multisigIsm.setThreshold(ORIGIN_DOMAIN, 2))
        .to.emit(multisigIsm, 'CommitmentUpdated')
        .withArgs(ORIGIN_DOMAIN, expectedCommitment);
    });

    it('reverts if the new quorum threshold is zero', async () => {
      await expect(
        multisigIsm.setThreshold(ORIGIN_DOMAIN, 0),
      ).to.be.revertedWith('!range');
    });

    it('reverts if the new quorum threshold is greater than the validator set size', async () => {
      await expect(
        multisigIsm.setThreshold(ORIGIN_DOMAIN, 3),
      ).to.be.revertedWith('!range');
    });

    it('reverts when called by a non-owner', async () => {
      await expect(
        multisigIsm.connect(nonOwner).setThreshold(ORIGIN_DOMAIN, 2),
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });
  });

  describe('#validators', () => {
    beforeEach(async () => {
      await multisigIsm.enrollValidators(
        [ORIGIN_DOMAIN],
        [validators.map((v) => v.address)],
      );
    });

    it('returns the validators', async () => {
      expect(await multisigIsm.validators(ORIGIN_DOMAIN)).to.deep.equal(
        validators.map((v) => v.address),
      );
    });
  });

  describe('#validatorsAndThreshold', () => {
    const threshold = 7;
    let message: string;
    beforeEach(async () => {
      await multisigIsm.enrollValidators(
        [ORIGIN_DOMAIN],
        [validators.map((v) => v.address)],
      );
      await multisigIsm.setThreshold(ORIGIN_DOMAIN, threshold);
      const dispatch = await dispatchMessage(
        mailbox,
        DESTINATION_DOMAIN,
        utils.addressToBytes32(multisigIsm.address),
        'hello',
      );
      message = dispatch.message;
    });

    it('returns the validators and threshold', async () => {
      expect(await multisigIsm.validatorsAndThreshold(message)).to.deep.equal([
        validators.map((v) => v.address),
        threshold,
      ]);
    });
  });

  describe('#validatorCount', () => {
    beforeEach(async () => {
      // Must be done sequentially so gas estimation is correct.
      for (const v of validators) {
        await multisigIsm.enrollValidator(ORIGIN_DOMAIN, v.address);
      }
    });

    it('returns the number of validators enrolled in the validator set', async () => {
      expect(await multisigIsm.validatorCount(ORIGIN_DOMAIN)).to.equal(
        validators.length,
      );
    });
  });

  describe('#verify', () => {
    let metadata: string, message: string, recipient: string;
    before(async () => {
      const recipientF = new TestRecipient__factory(signer);
      recipient = (await recipientF.deploy()).address;
    });

    beforeEach(async () => {
      // Must be done sequentially so gas estimation is correct
      // and so that signatures are produced in the same order.
      for (const v of validators) {
        await multisigIsm.enrollValidator(ORIGIN_DOMAIN, v.address);
      }
      await multisigIsm.setThreshold(ORIGIN_DOMAIN, validators.length - 1);

      ({ message, metadata } = await dispatchMessageAndReturnMetadata(
        mailbox,
        multisigIsm,
        DESTINATION_DOMAIN,
        recipient,
        'hello world',
        validators.slice(1),
      ));
    });

    it('returns true when valid metadata is provided', async () => {
      expect(await multisigIsm.verify(metadata, message)).to.be.true;
    });

    it('allows for message processing when valid metadata is provided', async () => {
      const mailboxFactory = new TestMailbox__factory(signer);
      const destinationMailbox = await mailboxFactory.deploy(
        DESTINATION_DOMAIN,
      );
      await destinationMailbox.initialize(signer.address, multisigIsm.address);
      await destinationMailbox.process(metadata, message);
    });

    it('reverts when non-validator signatures are provided', async () => {
      const nonValidator = await Validator.fromSigner(
        signer,
        ORIGIN_DOMAIN,
        mailbox.address,
      );
      const parsedMetadata = utils.parseMultisigIsmMetadata(metadata);
      const nonValidatorSignature = (
        await signCheckpoint(
          parsedMetadata.checkpointRoot,
          parsedMetadata.checkpointIndex,
          mailbox.address,
          [nonValidator],
        )
      )[0];
      parsedMetadata.signatures.push(nonValidatorSignature);
      const modifiedMetadata = utils.formatMultisigIsmMetadata({
        ...parsedMetadata,
        signatures: parsedMetadata.signatures.slice(1),
      });
      await expect(
        multisigIsm.verify(modifiedMetadata, message),
      ).to.be.revertedWith('!threshold');
    });

    it('reverts when the provided validator set does not match the stored commitment', async () => {
      const parsedMetadata = utils.parseMultisigIsmMetadata(metadata);
      const modifiedMetadata = utils.formatMultisigIsmMetadata({
        ...parsedMetadata,
        validators: parsedMetadata.validators.slice(1),
      });
      await expect(
        multisigIsm.verify(modifiedMetadata, message),
      ).to.be.revertedWith('!commitment');
    });

    it('reverts when an invalid merkle proof is provided', async () => {
      const parsedMetadata = utils.parseMultisigIsmMetadata(metadata);
      const modifiedMetadata = utils.formatMultisigIsmMetadata({
        ...parsedMetadata,
        proof: parsedMetadata.proof.reverse(),
      });
      await expect(
        multisigIsm.verify(modifiedMetadata, message),
      ).to.be.revertedWith('!merkle');
    });
  });

  describe('#isEnrolled', () => {
    beforeEach(async () => {
      await multisigIsm.enrollValidator(ORIGIN_DOMAIN, validators[0].address);
    });

    it('returns true if an address is enrolled in the validator set', async () => {
      expect(await multisigIsm.isEnrolled(ORIGIN_DOMAIN, validators[0].address))
        .to.be.true;
    });

    it('returns false if an address is not enrolled in the validator set', async () => {
      expect(await multisigIsm.isEnrolled(ORIGIN_DOMAIN, validators[1].address))
        .to.be.false;
    });
  });

  // TODO: Update rust code to output v2 domain hashes
  // TODO: Update rust code to output checkpoint digests
  describe.skip('#_getDomainHash', () => {
    it('matches Rust-produced domain hashes', async () => {
      // Compare Rust output in json file to solidity output (json file matches
      // hash for local domain of 1000)
      for (const testCase of domainHashTestCases) {
        const { expectedDomainHash } = testCase;
        // This public function on TestMultisigIsm exposes
        // the internal _domainHash on MultisigIsm.
        const domainHash = await multisigIsm.getDomainHash(
          testCase.originDomain,
          testCase.originMailbox,
        );
        expect(domainHash).to.equal(expectedDomainHash);
      }
    });
  });
});
