import { expect } from 'chai';
import ethers from 'ethers';

import { Signer } from './lib/types';
import { MysteryMathV1, MysteryMathV2, MysteryMathV1__factory, UpgradeBeacon, UpgradeBeaconController, UpgradeBeaconController__factory, UpgradeBeacon__factory, UpgradeBeaconProxy__factory} from '../typechain'

export const increaseTimestampBy = async (
  provider: ethers.providers.JsonRpcProvider,
  increaseTime: number,
) => {
  await provider.send('evm_increaseTime', [increaseTime]);
  await provider.send('evm_mine', []);
};

export type MysteryMathUpgrade = {
  proxy: MysteryMathV1 | MysteryMathV2;
  beacon: UpgradeBeacon;
  implementation: MysteryMathV1 | MysteryMathV2;
  ubc: UpgradeBeaconController;
};

export class UpgradeTestHelpers {
  a: number = 5;
  b: number = 10;
  stateVar: number = 17;

  async deployMysteryMathUpgradeSetup(
    signer: Signer,
  ): Promise<MysteryMathUpgrade> {
    // deploy implementation
    const mysteryMathFactory = new MysteryMathV1__factory(signer);
    const mysteryMathImplementation = await mysteryMathFactory.deploy();

    const ubcFactory = new UpgradeBeaconController__factory(signer);
    const ubc = await ubcFactory.deploy();

    // deploy and set upgrade beacon
    const beaconFactory = new UpgradeBeacon__factory(signer);
    const beacon = await beaconFactory.deploy(
    mysteryMathImplementation.address,
    ubc.address);

    // deploy proxy
    const proxyFactory = new UpgradeBeaconProxy__factory(signer);
    const upgradeBeaconProxy = await proxyFactory.deploy(beacon.address, []);

    // set proxy
    const proxy = mysteryMathFactory.attach(upgradeBeaconProxy.address);

    // Set state of proxy
    await proxy.setState(this.stateVar);

    return { proxy, beacon, implementation: mysteryMathImplementation, ubc};
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

export const stringToBytes32 = (s: string): string => {
  const str = Buffer.from(s.slice(0, 32), 'utf-8');
  const result = Buffer.alloc(32);
  str.copy(result);

  return '0x' + result.toString('hex');
};
