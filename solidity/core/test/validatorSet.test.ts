import { expect } from 'chai';
import { ethers } from 'hardhat';

import {
  TestBN256,
  TestBN256__factory,
  TestValidatorSet,
  TestValidatorSet__factory,
} from '../types';

import { G1Point, Validator } from './lib/validators';

describe.only('ValidatorSet', async () => {
  let validatorSet: TestValidatorSet, bn256: TestBN256;
  before(async () => {
    const [signer] = await ethers.getSigners();

    const bn256Factory = new TestBN256__factory(signer);
    bn256 = await bn256Factory.deploy();
  });

  beforeEach(async () => {
    const [signer] = await ethers.getSigners();

    const factory = new TestValidatorSet__factory(signer);
    validatorSet = await factory.deploy();
  });

  describe('#add', async () => {
    let publicKey: G1Point;
    before(async () => {
      const validator = new Validator(bn256);
      publicKey = await validator.publicKey();
    });

    it('adds the public key to the set', async () => {
      await validatorSet.add(publicKey);
      expect(await validatorSet.isValidator(publicKey)).to.be.true;
    });

    it('reverts when adding the same public key twice', async () => {
      await validatorSet.add(publicKey);
      await expect(validatorSet.add(publicKey)).to.be.revertedWith('enrolled');
    });

    it('reverts when adding an invalid public key', async () => {
      const invalidKey = {
        x: publicKey.y,
        y: publicKey.x,
      };
      await expect(validatorSet.add(invalidKey)).to.be.reverted;
    });
  });

  describe('#remove', async () => {
    let publicKey: G1Point;
    before(async () => {
      const validator = new Validator(bn256);
      publicKey = await validator.publicKey();
    });

    it('removes the public key from the set', async () => {
      await validatorSet.add(publicKey);
      await validatorSet.remove(publicKey);
      expect(await validatorSet.isValidator(publicKey)).to.be.false;
    });

    it('reverts when the public key is not part of the set', async () => {
      await expect(validatorSet.remove(publicKey)).to.be.revertedWith(
        '!enrolled',
      );
    });
  });

  describe('#setThreshold', async () => {});

  describe('#decompress', async () => {});

  describe('#verificationKey', async () => {});
});
