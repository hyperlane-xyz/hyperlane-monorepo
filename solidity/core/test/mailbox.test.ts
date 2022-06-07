import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import { TestMailbox, TestMailbox__factory } from '../types';

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const domainHashTestCases = require('../../../vectors/domainHash.json');

const localDomain = 1000;
const ONLY_OWNER_REVERT_MSG = 'Ownable: caller is not the owner';

describe('Mailbox', async () => {
  let owner: SignerWithAddress,
    nonowner: SignerWithAddress,
    mailbox: TestMailbox;

  before(async () => {
    [owner, nonowner] = await ethers.getSigners();
  });

  beforeEach(async () => {
    const mailboxFactory = new TestMailbox__factory(owner);
    mailbox = await mailboxFactory.deploy(localDomain);
    // The ValidatorManager is unused in these tests *but* needs to be a
    // contract.
    await mailbox.initialize(mailbox.address);
    expect(await mailbox.validatorManager()).to.equal(mailbox.address);
  });

  it('Cannot be initialized twice', async () => {
    await expect(mailbox.initialize(mailbox.address)).to.be.revertedWith(
      'Initializable: contract is already initialized',
    );
  });

  describe('#setValidatorManager', async () => {
    it('Allows owner to update the ValidatorManager', async () => {
      const mailboxFactory = new TestMailbox__factory(owner);
      const newValidatorManager = await mailboxFactory.deploy(localDomain);
      await mailbox.setValidatorManager(newValidatorManager.address);
      expect(await mailbox.validatorManager()).to.equal(
        newValidatorManager.address,
      );
    });

    it('Does not allow nonowner to update the ValidatorManager', async () => {
      await expect(
        mailbox.connect(nonowner).setValidatorManager(mailbox.address),
      ).to.be.revertedWith(ONLY_OWNER_REVERT_MSG);
    });
  });
  describe.skip('#verify', async () => {});

  describe('#_domainHash', () => {
    it('matches Rust-produced domain hashes', async () => {
      // Compare Rust output in json file to solidity output (json file matches
      // hash for local domain of 1000)
      for (const testCase of domainHashTestCases) {
        const { expectedDomainHash } = testCase;
        // This public function on TestMultisigValidatorManager exposes
        // the internal _domainHash on MultisigValidatorManager.
        const domainHash = await mailbox.domainHash(testCase.outboxDomain);
        expect(domainHash).to.equal(expectedDomainHash);
      }
    });
  });
});
