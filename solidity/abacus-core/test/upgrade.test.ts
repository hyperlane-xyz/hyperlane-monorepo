import { ethers } from "hardhat";

import { UpgradeTestHelpers, MysteryMathUpgrade } from "./utils";
import { Signer } from "./lib/types";
import { UpgradeBeaconController, MysteryMathV2__factory } from "../typechain";

describe("Upgrade", async () => {
  const utils = new UpgradeTestHelpers();
  let signer: Signer,
    mysteryMath: MysteryMathUpgrade,
    upgradeBeaconController: UpgradeBeaconController;

  before(async () => {
    // set signer
    [signer] = await ethers.getSigners();

    // deploy upgrade setup for mysteryMath contract
    mysteryMath = await utils.deployMysteryMathUpgradeSetup(signer);
  });

  it("Pre-Upgrade returns values from MysteryMathV1", async () => {
    await utils.expectMysteryMathV1(mysteryMath.proxy);
  });

  it("Upgrades without problem", async () => {
    // Deploy Implementation 2
    const factory = new MysteryMathV2__factory(signer);
    const implementation = await factory.deploy();

    // Upgrade to implementation 2
    await mysteryMath.ubc.upgrade(
      mysteryMath.beacon.address,
      implementation.address
    );
  });

  it("Post-Upgrade returns values from MysteryMathV2", async () => {
    await utils.expectMysteryMathV2(mysteryMath.proxy);
  });
});
