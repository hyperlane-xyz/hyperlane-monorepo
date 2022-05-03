import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { ethers } from 'hardhat';

import {
  MysteryMathV2__factory,
  UpgradeBeaconController,
  UpgradeBeaconController__factory,
} from '../types';

import { MysteryMathUpgrade, UpgradeTestHelpers } from './lib/upgrade';

describe('Upgrade', async () => {
  const utils = new UpgradeTestHelpers();
  let signer: SignerWithAddress,
    mysteryMath: MysteryMathUpgrade,
    ubc: UpgradeBeaconController;

  before(async () => {
    // set signer
    [signer] = await ethers.getSigners();

    const ubcFactory = new UpgradeBeaconController__factory(signer);
    ubc = await ubcFactory.deploy();

    // deploy upgrade setup for mysteryMath contract
    mysteryMath = await utils.deployMysteryMathUpgradeSetup(signer, ubc);
  });

  it('Pre-Upgrade returns values from MysteryMathV1', async () => {
    await utils.expectMysteryMathV1(mysteryMath.proxy);
  });

  it('Upgrades without problem', async () => {
    // Deploy Implementation 2
    const factory = new MysteryMathV2__factory(signer);
    const implementation = await factory.deploy();

    // Upgrade to implementation 2
    await ubc.upgrade(mysteryMath.beacon.address, implementation.address);
  });

  it('Post-Upgrade returns values from MysteryMathV2', async () => {
    await utils.expectMysteryMathV2(mysteryMath.proxy);
  });
});
