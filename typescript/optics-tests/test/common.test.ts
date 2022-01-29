import { ethers } from 'hardhat';
import { expect } from 'chai';

import { Updater } from '../lib/core';
import { Signer } from '../lib/types';

import {
  TestCommon__factory,
  TestCommon,
} from 'optics-ts-interface/dist/optics-core';

const signedUpdateTestCases = require('../../../vectors/signedUpdate.json');
const localDomain = 1000;

describe('Common', async () => {
  let signer: Signer,
    fakeSigner: Signer,
    common: TestCommon,
    updater: Updater,
    fakeUpdater: Updater;

  before(async () => {
    [signer, fakeSigner] = await ethers.getSigners();
    updater = await Updater.fromSigner(signer, localDomain);
    fakeUpdater = await Updater.fromSigner(fakeSigner, localDomain);
  });

  beforeEach(async () => {
    const commonFactory = new TestCommon__factory(signer);
    common = await commonFactory.deploy(localDomain, updater.address);
  });

  it('Accepts updater signature', async () => {
    const oldRoot = ethers.utils.formatBytes32String('old root');
    const newRoot = ethers.utils.formatBytes32String('new root');

    const { signature } = await updater.signUpdate(oldRoot, newRoot);
    const isValid = await common.testIsUpdaterSignature(
      oldRoot,
      newRoot,
      signature,
    );
    expect(isValid).to.be.true;
  });

  it('Rejects non-updater signature', async () => {
    const oldRoot = ethers.utils.formatBytes32String('old root');
    const newRoot = ethers.utils.formatBytes32String('new root');

    const { signature: fakeSignature } = await fakeUpdater.signUpdate(
      oldRoot,
      newRoot,
    );
    expect(await common.testIsUpdaterSignature(oldRoot, newRoot, fakeSignature))
      .to.be.false;
  });

  it('Checks Rust-produced SignedUpdate', async () => {
    // Compare Rust output in json file to solidity output
    for (let testCase of signedUpdateTestCases) {
      const { oldRoot, newRoot, signature, signer } = testCase;

      const signerAddress = ethers.utils.getAddress(signer);
      await common.setUpdater(signerAddress);

      expect(
        await common.testIsUpdaterSignature(
          oldRoot,
          newRoot,
          ethers.utils.joinSignature(signature),
        ),
      ).to.be.true;
    }
  });
});
