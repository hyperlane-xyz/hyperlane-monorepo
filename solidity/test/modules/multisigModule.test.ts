/* eslint-disable @typescript-eslint/no-floating-promises */
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import { Validator, utils } from '@hyperlane-xyz/utils';

import {
  TestMailbox,
  TestMailbox__factory,
  TestMultisigModule,
  TestMultisigModule__factory,
  TestRecipient__factory,
} from '../../types';
import {
  dispatchMessageAndReturnMetadata,
  getCommitment,
} from '../lib/mailboxes';

const ORIGIN_DOMAIN = 1234;
const DESTINATION_DOMAIN = 4321;
const version = 0;

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const domainHashTestCases = require('../../../vectors/domainHash.json');

describe('MultisigModule', async () => {
  let multisigModule: TestMultisigModule,
    mailbox: TestMailbox,
    signer: SignerWithAddress,
    nonOwner: SignerWithAddress,
    validators: Validator[];

  before(async () => {
    const signers = await ethers.getSigners();
    [signer, nonOwner] = signers;
    const mailboxFactory = new TestMailbox__factory(signer);
    mailbox = await mailboxFactory.deploy(ORIGIN_DOMAIN, version);
    validators = await Promise.all(
      signers
        .filter((_, i) => i > 1)
        .map((s) => Validator.fromSigner(s, ORIGIN_DOMAIN, mailbox.address)),
    );
  });

  beforeEach(async () => {
    const multisigModuleFactory = new TestMultisigModule__factory(signer);
    multisigModule = await multisigModuleFactory.deploy();
  });

  describe('#constructor', () => {
    it('sets the owner', async () => {
      expect(await multisigModule.owner()).to.equal(signer.address);
    });
  });

  describe('#enrollValidator', () => {
    it('enrolls a validator into the validator set', async () => {
      await multisigModule.enrollValidator(
        ORIGIN_DOMAIN,
        validators[0].address,
      );

      expect(await multisigModule.validators(ORIGIN_DOMAIN)).to.deep.equal([
        validators[0].address,
      ]);
    });

    it('emits the ValidatorEnrolled event', async () => {
      const expectedCommitment = getCommitment(0, [validators[0].address]);
      expect(
        await multisigModule.enrollValidator(
          ORIGIN_DOMAIN,
          validators[0].address,
        ),
      )
        .to.emit(multisigModule, 'ValidatorEnrolled')
        .withArgs(ORIGIN_DOMAIN, validators[0].address, 1, expectedCommitment);
    });

    it('reverts if the validator is already enrolled', async () => {
      await multisigModule.enrollValidator(
        ORIGIN_DOMAIN,
        validators[0].address,
      );
      await expect(
        multisigModule.enrollValidator(ORIGIN_DOMAIN, validators[0].address),
      ).to.be.revertedWith('already enrolled');
    });

    it('reverts when called by a non-owner', async () => {
      await expect(
        multisigModule
          .connect(nonOwner)
          .enrollValidator(ORIGIN_DOMAIN, validators[0].address),
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });
  });

  describe('#unenrollValidator', () => {
    beforeEach(async () => {
      await multisigModule.enrollValidator(
        ORIGIN_DOMAIN,
        validators[0].address,
      );
    });

    it('unenrolls a validator from the validator set', async () => {
      await multisigModule.unenrollValidator(
        ORIGIN_DOMAIN,
        validators[0].address,
      );

      expect(await multisigModule.validators(ORIGIN_DOMAIN)).to.deep.equal([]);
    });

    it('emits the ValidatorUnenrolled event', async () => {
      const expectedCommitment = getCommitment(0, []);
      expect(
        await multisigModule.unenrollValidator(
          ORIGIN_DOMAIN,
          validators[0].address,
        ),
      )
        .to.emit(multisigModule, 'ValidatorUnenrolled')
        .withArgs(ORIGIN_DOMAIN, validators[0].address, 0, expectedCommitment);
    });

    it('reverts if the resulting validator set size will be less than the quorum threshold', async () => {
      await multisigModule.setThreshold(ORIGIN_DOMAIN, 1);

      await expect(
        multisigModule.unenrollValidator(ORIGIN_DOMAIN, validators[0].address),
      ).to.be.revertedWith('violates quorum threshold');
    });

    it('reverts if the validator is not already enrolled', async () => {
      await expect(
        multisigModule.unenrollValidator(ORIGIN_DOMAIN, validators[1].address),
      ).to.be.revertedWith('!enrolled');
    });

    it('reverts when called by a non-owner', async () => {
      await expect(
        multisigModule
          .connect(nonOwner)
          .unenrollValidator(ORIGIN_DOMAIN, validators[0].address),
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });
  });

  describe('#setThreshold', () => {
    beforeEach(async () => {
      // Have 2 validators to allow us to have more than 1 valid
      // quorum threshold
      await multisigModule.enrollValidator(
        ORIGIN_DOMAIN,
        validators[0].address,
      );
      await multisigModule.enrollValidator(
        ORIGIN_DOMAIN,
        validators[1].address,
      );
    });

    it('sets the quorum threshold', async () => {
      await multisigModule.setThreshold(ORIGIN_DOMAIN, 2);

      expect(await multisigModule.threshold(ORIGIN_DOMAIN)).to.equal(2);
    });

    it('emits the SetThreshold event', async () => {
      const expectedCommitment = getCommitment(2, [
        validators[0].address,
        validators[1].address,
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

  describe('#validators', () => {
    beforeEach(async () => {
      // Must be done sequentially so gas estimation is correct.
      for (const v of validators) {
        await multisigModule.enrollValidator(ORIGIN_DOMAIN, v.address);
      }
    });

    it('returns the validators sorted in ascending order', async () => {
      const expected = utils.sortAddresses(validators.map((v) => v.address));
      expect(await multisigModule.validators(ORIGIN_DOMAIN)).to.deep.equal(
        expected,
      );
    });
  });

  describe('#validatorCount', () => {
    beforeEach(async () => {
      // Must be done sequentially so gas estimation is correct.
      for (const v of validators) {
        await multisigModule.enrollValidator(ORIGIN_DOMAIN, v.address);
      }
    });

    it('returns the number of validators enrolled in the validator set', async () => {
      expect(await multisigModule.validatorCount(ORIGIN_DOMAIN)).to.equal(
        validators.length,
      );
    });
  });

  describe('#verify', () => {
    let recipient;
    let metadata: string, message: string;
    beforeEach(async () => {
      // Must be done sequentially so gas estimation is correct.
      for (const v of validators) {
        await multisigModule.enrollValidator(ORIGIN_DOMAIN, v.address);
      }
      await multisigModule.setThreshold(ORIGIN_DOMAIN, validators.length);
    });

    before(async () => {
      const recipientF = new TestRecipient__factory(signer);
      recipient = (await recipientF.deploy()).address;
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

    it('allows for message processing when valid metadata is provided', async () => {
      const mailboxFactory = new TestMailbox__factory(signer);
      const destinationMailbox = await mailboxFactory.deploy(
        DESTINATION_DOMAIN,
        version,
      );
      await destinationMailbox.initialize(multisigModule.address);
      await destinationMailbox.process(metadata, message);
    });

    it.skip('reverts when not enough signatures are provided', async () => {
      const modifiedMetadata = metadata;
      expect(
        await multisigModule.verify(modifiedMetadata, message),
      ).to.be.revertedWith('!threshold');
    });

    it.skip('reverts the provided validator set does not match the stored commitment', async () => {
      const modifiedMetadata = metadata;
      expect(
        await multisigModule.verify(modifiedMetadata, message),
      ).to.be.revertedWith('!commitment');
    });

    it.skip('reverts when an invalid merkle proof is provided', async () => {
      const modifiedMetadata = metadata;
      expect(
        await multisigModule.verify(modifiedMetadata, message),
      ).to.be.revertedWith('!merkle');
    });
  });

  describe('#isValidator', () => {
    beforeEach(async () => {
      await multisigModule.enrollValidator(
        ORIGIN_DOMAIN,
        validators[0].address,
      );
    });

    it('returns true if an address is enrolled in the validator set', async () => {
      expect(
        await multisigModule.isValidator(ORIGIN_DOMAIN, validators[0].address),
      ).to.be.true;
    });

    it('returns false if an address is not enrolled in the validator set', async () => {
      expect(
        await multisigModule.isValidator(ORIGIN_DOMAIN, validators[1].address),
      ).to.be.false;
    });
  });

  describe.skip('#_domainHash', () => {
    it('matches Rust-produced domain hashes', async () => {
      // Compare Rust output in json file to solidity output (json file matches
      // hash for local domain of 1000)
      for (const testCase of domainHashTestCases) {
        const { expectedDomainHash } = testCase;
        // This public function on TestMultisigModule exposes
        // the internal _domainHash on MultisigModule.
        const domainHash = await multisigModule.getDomainHash(
          testCase.originDomain,
          testCase.originMailbox,
        );
        expect(domainHash).to.equal(expectedDomainHash);
      }
    });
  });
});
