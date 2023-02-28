/* eslint-disable @typescript-eslint/no-floating-promises */
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import { Validator, types, utils } from '@hyperlane-xyz/utils';

import {
  LightTestRecipient__factory,
  TestMailbox,
  TestMailbox__factory,
  TestMultisigIsm,
  TestMultisigIsm__factory,
  TestRecipient__factory,
} from '../../types';
import {
  dispatchMessage,
  dispatchMessageAndReturnMetadata,
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
    validators: Validator[];

  before(async () => {
    const signers = await ethers.getSigners();
    [signer] = signers;
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

  describe('#validatorsAndThreshold', () => {
    const threshold = 7;
    let message: string;
    beforeEach(async () => {
      await multisigIsm.addMany(
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
        await multisigIsm.add(ORIGIN_DOMAIN, v.address);
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
      ).to.be.revertedWith('!matches');
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

  // Manually unskip to run gas instrumentation.
  // The JSON that's logged can then be copied to `typescript/sdk/src/consts/multisigIsmVerifyCosts.json`,
  // which is ultimately used for configuring the default ISM overhead IGP.
  describe.skip('#verify gas instrumentation for the OverheadISM', () => {
    const MAX_VALIDATOR_COUNT = 18;
    let metadata: string, message: string, recipient: string;

    const gasOverhead: Record<number, Record<number, number>> = {};

    before(async () => {
      const recipientF = new LightTestRecipient__factory(signer);
      recipient = (await recipientF.deploy()).address;
    });

    after(() => {
      // eslint-disable-next-line no-console
      console.log('Instrumented gas overheads:');
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(gasOverhead));
    });

    for (
      let numValidators = 1;
      numValidators <= MAX_VALIDATOR_COUNT;
      numValidators++
    ) {
      for (let threshold = 1; threshold <= numValidators; threshold++) {
        it(`instrument mailbox.process gas costs with ${threshold} of ${numValidators} multisig`, async () => {
          const enrolledValidators = validators.slice(0, numValidators);
          // Must be done sequentially so gas estimation is correct
          // and so that signatures are produced in the same order.
          for (const v of enrolledValidators) {
            await multisigIsm.add(ORIGIN_DOMAIN, v.address);
          }
          const signingValidators = enrolledValidators.slice(0, threshold);

          await multisigIsm.setThreshold(ORIGIN_DOMAIN, threshold);

          const maxBodySize = await mailbox.MAX_MESSAGE_BODY_BYTES();
          // The max body is used to estimate an upper bound on gas usage.
          const maxBody = '0x' + 'AA'.repeat(maxBodySize.toNumber());

          ({ message, metadata } = await dispatchMessageAndReturnMetadata(
            mailbox,
            multisigIsm,
            DESTINATION_DOMAIN,
            recipient,
            maxBody,
            signingValidators,
            false,
          ));

          const mailboxFactory = new TestMailbox__factory(signer);
          const destinationMailbox = await mailboxFactory.deploy(
            DESTINATION_DOMAIN,
          );
          await destinationMailbox.initialize(
            signer.address,
            multisigIsm.address,
          );
          const gas = await destinationMailbox.estimateGas.process(
            metadata,
            message,
          );

          if (gasOverhead[numValidators] === undefined) {
            gasOverhead[numValidators] = {};
          }
          gasOverhead[numValidators][threshold] = gas.toNumber();
        });
      }
    }
  });
});
