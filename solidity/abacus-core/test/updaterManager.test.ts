import { ethers, abacus } from 'hardhat';
import { expect } from 'chai';

import { AbacusState, Validator } from './lib/core';
import { Signer } from './lib/types';

import {
  Home__factory,
  Home,
  ValidatorManager__factory,
  ValidatorManager,
} from '../typechain';

const homeDomainHashCases = require('../../../vectors/homeDomainHash.json');
const signedUpdateCases = require('../../../vectors/signedUpdate.json');
const localDomain = 1000;

describe('ValidatorManager', async () => {
  let signer: Signer,
    fakeSigner: Signer,
    validatorManager: ValidatorManager,
    validator: Validator,
    fakeValidator: Validator;

  before(async () => {
    [signer, fakeSigner] = await ethers.getSigners();
    validator = await Validator.fromSigner(signer, localDomain);
    fakeValidator = await Validator.fromSigner(fakeSigner, localDomain);
  });

  beforeEach(async () => {
    const validatorManagerFactory = new ValidatorManager__factory(signer);
    validatorManager = await validatorManagerFactory.deploy();
  });

  it('Accepts validator signature', async () => {
    const root = ethers.utils.formatBytes32String('root');
    const index = 1;

    const { signature } = await validator.signCheckpoint(root, index);
    const isValid = await validatorManager.isValidatorSignature(
      localDomain,
      root,
      index,
      signature,
    );
    expect(isValid).to.be.true;
  });

  it('Rejects non-validator signature', async () => {
    const root = ethers.utils.formatBytes32String('root');
    const index = 1;

    const { signature } = await fakeValidator.signCheckpoint(root, index);
    const isValid = await validatorManager.isValidatorSignature(
      localDomain,
      root,
      index,
      signature,
    );
    expect(isValid).to.be.false;
  });

  it('Calculated domain hash matches Rust-produced domain hash', async () => {
    // Compare Rust output in json file to solidity output (json file matches
    // hash for local domain of 1000)
    for (let testCase of homeDomainHashCases) {
      const { expectedDomainHash } = testCase;
      const domainHash = await validatorManager.domainHash(testCase.homeDomain);
      expect(domainHash).to.equal(expectedDomainHash);
    }
  });

  describe('improper updates', async () => {
    let home: Home;
    beforeEach(async () => {
      const homeFactory = new Home__factory(signer);
      home = await homeFactory.deploy(localDomain);
      await home.initialize(validatorManager.address);
    });

    it('Accepts improper update from validator', async () => {
      const root = ethers.utils.formatBytes32String('root');
      const index = 1;

      const { signature } = await validator.signCheckpoint(root, index);
      // Send message with signer address as msg.sender
      await expect(
        validatorManager.improperUpdate(home.address, root, index, signature),
      )
        .to.emit(validatorManager, 'ImproperUpdate')
        .withArgs(
          home.address,
          localDomain,
          validator.address,
          root,
          index,
          signature,
        );
      expect(await home.state()).to.equal(AbacusState.FAILED);
    });

    it('Rejects improper update from non-validator', async () => {
      const root = ethers.utils.formatBytes32String('root');
      const index = 1;

      const { signature } = await fakeValidator.signCheckpoint(root, index);
      // Send message with signer address as msg.sender
      await expect(
        validatorManager.improperUpdate(home.address, root, index, signature),
      ).to.be.revertedWith('!validator sig');
    });

    it('Rejects proper update from validator', async () => {
      const message = `0x${Buffer.alloc(10).toString('hex')}`;
      await home.dispatch(
        localDomain,
        abacus.ethersAddressToBytes32(signer.address),
        message,
      );
      await home.checkpoint();
      const [root, index] = await home.latestCheckpoint();

      const { signature } = await validator.signCheckpoint(
        root,
        index.toNumber(),
      );
      // Send message with signer address as msg.sender
      await expect(
        validatorManager.improperUpdate(home.address, root, index, signature),
      ).to.be.revertedWith('!improper');
    });
  });
});
