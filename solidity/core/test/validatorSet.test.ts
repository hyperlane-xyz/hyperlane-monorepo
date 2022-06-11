import { expect } from 'chai';
import { ethers } from 'hardhat';

import {
  TestBN256,
  TestBN256__factory,
  TestValidatorSet,
  TestValidatorSet__factory,
} from '../types';

import {
  G1Point,
  Validator,
  ValidatorSet,
  addPoints,
  ecCompress,
} from './lib/validators';

describe('ValidatorSet', async () => {
  let validatorSet: TestValidatorSet,
    bn256: TestBN256,
    validator: Validator,
    publicKey: G1Point;
  before(async () => {
    const [signer] = await ethers.getSigners();

    const bn256Factory = new TestBN256__factory(signer);
    bn256 = await bn256Factory.deploy();
    validator = new Validator(bn256);
    publicKey = await validator.publicKey();
  });

  beforeEach(async () => {
    const [signer] = await ethers.getSigners();

    const factory = new TestValidatorSet__factory(signer);
    validatorSet = await factory.deploy();
  });

  describe('#add', async () => {
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

  describe('#decompress', async () => {
    it('decompresses compressed validator public key', async () => {
      await validatorSet.add(publicKey);
      expect(
        await validatorSet.decompress(await validator.compressedPublicKey()),
      ).to.deep.equal(publicKey);
    });

    it('reverts when given a non-validator public key', async () => {
      const nonValidator = new Validator(bn256);
      await expect(
        validatorSet.decompress(await nonValidator.compressedPublicKey()),
      ).to.be.revertedWith('!validator');
    });
  });

  describe('#verificationKey', async () => {
    let validators: G1Point[];
    const size = 5;
    const threshold = 2;

    beforeEach(async () => {
      // domainHash can be anything since we're not signing
      const domainHash = ethers.utils.hexlify(ethers.utils.randomBytes(32));
      const set = new ValidatorSet(size, bn256, domainHash);
      validators = await set.publicKeys();

      await Promise.all(validators.map((v) => validatorSet.add(v)));
      await validatorSet.setThreshold(threshold);
    });

    it('returns the aggregate public key', async () => {
      let missing = validators.slice(0, threshold).map((k) => ecCompress(k));
      missing = missing.map((m) => m.toLowerCase()).sort();

      const signing = validators.slice(threshold);
      const expected = await addPoints(signing, bn256);
      expect(await validatorSet.verificationKey(missing)).to.deep.equal(
        expected,
      );
    });

    it('reverts if the verification key would not constitute a quorum', async () => {
      let missing = validators
        .slice(0, threshold + 1)
        .map((k) => ecCompress(k));
      missing = missing.map((m) => m.toLowerCase()).sort();
      await expect(validatorSet.verificationKey(missing)).to.be.revertedWith(
        '!threshold',
      );
    });

    it('reverts if the missing keys are not sorted', async () => {
      let missing = validators.slice(0, threshold).map((k) => ecCompress(k));
      missing = missing
        .map((m) => m.toLowerCase())
        .sort()
        .reverse();
      await expect(validatorSet.verificationKey(missing)).to.be.revertedWith(
        '!sorted',
      );
    });

    it('reverts if the missing keys have duplicates', async () => {
      let missing = validators.slice(0, threshold).map((k) => ecCompress(k));
      missing = missing.map((m) => m.toLowerCase()).sort();
      missing[1] = missing[0];
      await expect(validatorSet.verificationKey(missing)).to.be.revertedWith(
        '!sorted',
      );
    });

    it('reverts if the missing keys contain a non-validator', async () => {
      const nonValidator = await new Validator(bn256).compressedPublicKey();
      await expect(
        validatorSet.verificationKey([nonValidator]),
      ).to.be.revertedWith('!validator');
    });
  });
});
