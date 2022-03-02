import { ethers } from 'hardhat';
import { expect } from 'chai';
import { Signer } from './lib/types';
import { AbacusState, Validator, formatMessage, messageHash, destinationAndNonce } from './lib/core';
import { addressToBytes32 } from './lib/utils';

import { TestOutbox, TestOutbox__factory } from '../typechain';

const destinationNonceTestCases = require('../../../vectors/destinationNonce.json');

const localDomain = 1000;
const destDomain = 2000;

describe('Outbox', async () => {
  let outbox: TestOutbox, signer: Signer, recipient: Signer;

  before(async () => {
    [signer, recipient] = await ethers.getSigners();
  });

  beforeEach(async () => {
    // redeploy the outbox before each test run
    const outboxFactory = new TestOutbox__factory(signer);
    outbox = await outboxFactory.deploy(localDomain);
    // The ValidatorManager is unused in these tests *but* needs to be a
    // contract.
    await outbox.initialize(outbox.address);
  });

  it('Cannot be initialized twice', async () => {
    await expect(outbox.initialize(outbox.address)).to.be.revertedWith(
      'Initializable: contract is already initialized',
    );
  });

  it('ValidatorManager can fail', async () => {
    await outbox.testSetValidatorManager(signer.address);
    await outbox.fail();
    expect(await outbox.state()).to.equal(AbacusState.FAILED);

    const message = ethers.utils.formatBytes32String('message');
    await expect(
      outbox.dispatch(
        destDomain,
        addressToBytes32(recipient.address),
        message,
      ),
    ).to.be.revertedWith('failed state');
  });

  it('Non ValidatorManager cannot fail', async () => {
    await expect(outbox.connect(recipient).fail()).to.be.revertedWith(
      '!validatorManager',
    );
  });

  it('Does not dispatch too large messages', async () => {
    const message = `0x${Buffer.alloc(3000).toString('hex')}`;
    await expect(
      outbox.dispatch(
        destDomain,
        addressToBytes32(recipient.address),
        message,
      ),
    ).to.be.revertedWith('msg too long');
  });

  it('Dispatches a message', async () => {
    const message = ethers.utils.formatBytes32String('message');
    const nonce = await outbox.nonces(localDomain);

    // Format data that will be emitted from Dispatch event
    const destAndNonce = destinationAndNonce(destDomain, nonce);

    const abacusMessage = formatMessage(
      localDomain,
      signer.address,
      nonce,
      destDomain,
      recipient.address,
      message,
    );
    const hash = messageHash(abacusMessage);
    const leafIndex = await outbox.tree();
    const [checkpointedRoot] = await outbox.latestCheckpoint();

    // Send message with signer address as msg.sender
    await expect(
      outbox
        .connect(signer)
        .dispatch(
          destDomain,
          addressToBytes32(recipient.address),
          message,
        ),
    )
      .to.emit(outbox, 'Dispatch')
      .withArgs(
        hash,
        leafIndex,
        destAndNonce,
        checkpointedRoot,
        abacusMessage,
      );
  });

  it('Checkpoints the latest root', async () => {
    const message = ethers.utils.formatBytes32String('message');
    await outbox.dispatch(
      destDomain,
      addressToBytes32(recipient.address),
      message,
    );
    await outbox.checkpoint();
    const [root, index] = await outbox.latestCheckpoint();
    expect(root).to.not.equal(ethers.constants.HashZero);
    expect(index).to.equal(1);
  });

  it('Correctly calculates destinationAndNonce', async () => {
    for (let testCase of destinationNonceTestCases) {
      let { destination, nonce, expectedDestinationAndNonce } = testCase;
      const solidityDestinationAndNonce = await outbox.destinationAndNonce(
        destination,
        nonce,
      );
      expect(solidityDestinationAndNonce).to.equal(expectedDestinationAndNonce);
    }
  });
});
