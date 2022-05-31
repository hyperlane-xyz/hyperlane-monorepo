import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';

import {
  MysteryMathV1,
  MysteryMathV1__factory,
  MysteryMathV2,
  UpgradeBeacon,
  UpgradeBeaconController,
  UpgradeBeaconProxy__factory,
  UpgradeBeacon__factory,
} from '../../types';

export type MysteryMathUpgrade = {
  proxy: MysteryMathV1 | MysteryMathV2;
  beacon: UpgradeBeacon;
  implementation: MysteryMathV1 | MysteryMathV2;
};

export class UpgradeTestHelpers {
  a = 5;
  b = 10;
  stateVar = 17;

  async deployMysteryMathUpgradeSetup(
    signer: SignerWithAddress,
    ubc: UpgradeBeaconController,
  ): Promise<MysteryMathUpgrade> {
    // deploy implementation
    const mysteryMathFactory = new MysteryMathV1__factory(signer);
    const mysteryMathImplementation = await mysteryMathFactory.deploy();

    // deploy and set upgrade beacon
    const beaconFactory = new UpgradeBeacon__factory(signer);
    const beacon = await beaconFactory.deploy(
      mysteryMathImplementation.address,
      ubc.address,
    );

    // deploy proxy
    const proxyFactory = new UpgradeBeaconProxy__factory(signer);
    const upgradeBeaconProxy = await proxyFactory.deploy(beacon.address, []);

    // set proxy
    const proxy = mysteryMathFactory.attach(upgradeBeaconProxy.address);

    // Set state of proxy
    await proxy.setState(this.stateVar);

    return { proxy, beacon, implementation: mysteryMathImplementation };
  }

  async expectMysteryMathV1(mysteryMathProxy: MysteryMathV1) {
    const versionResult = await mysteryMathProxy.version();
    expect(versionResult).to.equal(1);

    const mathResult = await mysteryMathProxy.doMath(this.a, this.b);
    expect(mathResult).to.equal(this.a + this.b);

    const stateResult = await mysteryMathProxy.getState();
    expect(stateResult).to.equal(this.stateVar);
  }

  async expectMysteryMathV2(mysteryMathProxy: MysteryMathV2) {
    const versionResult = await mysteryMathProxy.version();
    expect(versionResult).to.equal(2);

    const mathResult = await mysteryMathProxy.doMath(this.a, this.b);
    expect(mathResult).to.equal(this.a * this.b);

    const stateResult = await mysteryMathProxy.getState();
    expect(stateResult).to.equal(this.stateVar);
  }
}
