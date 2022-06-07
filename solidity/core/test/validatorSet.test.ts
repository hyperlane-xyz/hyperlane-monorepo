import { expect } from 'chai';
import { ethers } from 'hardhat';

import { TestValidatorSet, TestValidatorSet__factory } from '../types';

import { Validator } from './lib/validators';

describe('ValidatorSet', async () => {
  let validatorSet: TestValidatorSet;
  beforeEach(async () => {
    const [signer] = await ethers.getSigners();

    const factory = new TestValidatorSet__factory(signer);
    validatorSet = await factory.deploy();
  });

  describe('#add', async () => {
    it('adds the public key to the set', async () => {
      const validator = new Validator();
      await validatorSet.add();
      // Check aggregate key, yValue
    });

    it('reverts when adding the same public key twice', async () => {});

    it('reverts when adding an invalid public key', async () => {});
  });

  describe('#remove', async () => {
    it('removes the public key from the set', async () => {
      // Check aggregate key, yValue
    });

    it('reverts when the public key is not part of the set', async () => {});
  });

  describe('#setThreshold', async () => {
    it('sets the threshold value', async () => {});
  });

  describe('#verificationKey', async () => {});
});
