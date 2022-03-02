import { ethers, abacus } from 'hardhat';
import { expect } from 'chai';

import { AbacusState, Validator } from './lib/core';
import { Signer } from './lib/types';

import {
  Outbox__factory,
  Outbox,
  ValidatorManager__factory,
  ValidatorManager,
} from '../typechain';

const outboxDomainHashCases = require('../../../vectors/outboxDomainHash.json');
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
    await validatorManager.setValidator(localDomain, validator.address);
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
    for (let testCase of outboxDomainHashCases) {
      const { expectedDomainHash } = testCase;
      const domainHash = await validatorManager.domainHash(
        testCase.outboxDomain,
      );
      expect(domainHash).to.equal(expectedDomainHash);
    }
  });

  describe('improper checkpoints', async () => {
    let outbox: Outbox;
    beforeEach(async () => {
      const outboxFactory = new Outbox__factory(signer);
      outbox = await outboxFactory.deploy(localDomain);
      await outbox.initialize(validatorManager.address);
    });

    it('Accepts improper checkpoint from validator', async () => {
      const root = ethers.utils.formatBytes32String('root');
      const index = 1;

      const { signature } = await validator.signCheckpoint(root, index);
      // Send message with signer address as msg.sender
      await expect(
        validatorManager.improperCheckpoint(
          outbox.address,
          root,
          index,
          signature,
        ),
      )
        .to.emit(validatorManager, 'ImproperCheckpoint')
        .withArgs(
          outbox.address,
          localDomain,
          validator.address,
          root,
          index,
          signature,
        );
      expect(await outbox.state()).to.equal(AbacusState.FAILED);
    });

    it('Rejects improper checkpoint from non-validator', async () => {
      const root = ethers.utils.formatBytes32String('root');
      const index = 1;

      const { signature } = await fakeValidator.signCheckpoint(root, index);
      // Send message with signer address as msg.sender
      await expect(
        validatorManager.improperCheckpoint(
          outbox.address,
          root,
          index,
          signature,
        ),
      ).to.be.revertedWith('!validator sig');
    });

    it('Rejects proper checkpoint from validator', async () => {
      const message = `0x${Buffer.alloc(10).toString('hex')}`;
      await outbox.dispatch(
        localDomain,
        abacus.ethersAddressToBytes32(signer.address),
        message,
      );
      await outbox.checkpoint();
      const [root, index] = await outbox.latestCheckpoint();

      const { signature } = await validator.signCheckpoint(
        root,
        index.toNumber(),
      );
      // Send message with signer address as msg.sender
      await expect(
        validatorManager.improperCheckpoint(
          outbox.address,
          root,
          index,
          signature,
        ),
      ).to.be.revertedWith('!improper');
    });
  });
});
