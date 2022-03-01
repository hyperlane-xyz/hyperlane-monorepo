import { ethers } from 'hardhat';
import { expect } from 'chai';

import { Address, Signer } from './lib/types';

import { TestCommon__factory, TestCommon } from '../typechain';

const localDomain = 1000;
const ONLY_OWNER_REVERT_MSG = 'Ownable: caller is not the owner';

describe('Common', async () => {
  let owner: Signer,
    nonowner: Signer,
    updaterManager: Address,
    common: TestCommon;

  before(async () => {
    [owner, nonowner] = await ethers.getSigners();
  });

  beforeEach(async () => {
    const commonFactory = new TestCommon__factory(owner);
    common = await commonFactory.deploy(localDomain);
    updaterManager = ethers.utils.hexlify(ethers.utils.randomBytes(20));
    await common.initialize(updaterManager);
    expect(await common.updaterManager()).to.equal(updaterManager);
  });

  it('Cannot be initialized twice', async () => {
    await expect(common.initialize(updaterManager)).to.be.revertedWith(
      'Initializable: contract is already initialized',
    );
  });

  it('Allows owner to update the UpdaterManager', async () => {
    const newUpdaterManager = ethers.utils.hexlify(
      ethers.utils.randomBytes(20),
    );
    await common.setUpdaterManager(newUpdaterManager);
    expect(await common.updaterManager()).to.equal(newUpdaterManager);
  });

  it('Does not allow nonowner to updater the UpdaterManager', async () => {
    const newUpdaterManager = ethers.utils.hexlify(
      ethers.utils.randomBytes(20),
    );
    await expect(
      common.connect(nonowner).setUpdaterManager(newUpdaterManager),
    ).to.be.revertedWith(ONLY_OWNER_REVERT_MSG);
  });
});
