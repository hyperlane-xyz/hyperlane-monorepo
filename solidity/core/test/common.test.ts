import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import { TestMailbox, TestMailbox__factory } from '../types';

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

  it('Caches a checkpoint', async () => {
    const root =
      '0x9c7a007113f829cfd019a91e4ca5e7f6760589fd6bc7925c877f6971ffee1647';
    const index = 1;
    await mailbox.cacheCheckpoint(root, index);
    expect(await mailbox.latestCachedRoot()).to.equal(root);
    expect(await mailbox.cachedCheckpoints(root)).to.equal(index);
    const [actualRoot, actualIndex] = await mailbox.latestCachedCheckpoint();
    expect(actualRoot).to.equal(root);
    expect(actualIndex).to.equal(index);
  });

  it('Reverts when caching a checkpoint with index zero', async () => {
    const root =
      '0x9c7a007113f829cfd019a91e4ca5e7f6760589fd6bc7925c877f6971ffee1647';
    const index = 0;
    await expect(mailbox.cacheCheckpoint(root, index)).to.be.revertedWith(
      '!index',
    );
  });
});
