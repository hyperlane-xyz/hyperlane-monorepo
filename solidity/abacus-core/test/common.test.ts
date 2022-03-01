import { ethers } from 'hardhat';
import { expect } from 'chai';

import { Address, Signer } from './lib/types';

import { TestCommon__factory, TestCommon } from '../typechain';

const localDomain = 1000;
const ONLY_OWNER_REVERT_MSG = 'Ownable: caller is not the owner';

describe('Common', async () => {
  let owner: Signer,
    nonowner: Signer,
    common: TestCommon;

  before(async () => {
    [owner, nonowner] = await ethers.getSigners();
  });

  beforeEach(async () => {
    const commonFactory = new TestCommon__factory(owner);
    common = await commonFactory.deploy(localDomain);
    // The ValidatorManager is unused in these tests *but* needs to be a
    // contract.
    await common.initialize(common.address);
    expect(await common.validatorManager()).to.equal(common.address);
  });

  it('Cannot be initialized twice', async () => {
    await expect(common.initialize(common.address)).to.be.revertedWith(
      'Initializable: contract is already initialized',
    );
  });

  it('Allows owner to update the ValidatorManager', async () => {
    const commonFactory = new TestCommon__factory(owner);
    const newValidatorManager = await commonFactory.deploy(localDomain);
    await common.setValidatorManager(newValidatorManager.address);
    expect(await common.validatorManager()).to.equal(newValidatorManager.address);
  });

  it('Does not allow nonowner to update the ValidatorManager', async () => {
    await expect(
      common.connect(nonowner).setValidatorManager(common.address),
    ).to.be.revertedWith(ONLY_OWNER_REVERT_MSG);
  });
});
