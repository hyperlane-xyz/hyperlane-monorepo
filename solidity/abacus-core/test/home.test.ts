import { ethers, abacus } from 'hardhat';
import { expect } from 'chai';
import { AbacusState, Updater } from './lib/core';
import { Signer } from './lib/types';

import {
  TestHome,
  TestHome__factory,
} from '../typechain';

const destinationNonceTestCases = require('../../../vectors/destinationNonce.json');

const localDomain = 1000;
const destDomain = 2000;
const nullAddress: string = '0x' + '00'.repeat(32);

describe('Home', async () => {
  let home: TestHome,
    signer: Signer,
    recipient: Signer;

  before(async () => {
    [signer, recipient] = await ethers.getSigners();
  });

  beforeEach(async () => {
    // redeploy the home before each test run
    const homeFactory = new TestHome__factory(signer);
    home = await homeFactory.deploy(localDomain);
    await home.initialize(signer.address);
  });

  it('Cannot be initialized twice', async () => {
    await expect(home.initialize(signer.address)).to.be.revertedWith(
      'Initializable: contract is already initialized',
    );
  });

  it('UpdaterManager can fail', async () => {
    await home.fail();
    expect(await home.state()).to.equal(AbacusState.FAILED);

    const message = ethers.utils.formatBytes32String('message');
    await expect(
      home.dispatch(
        destDomain,
        abacus.ethersAddressToBytes32(recipient.address),
        message,
      ),
    ).to.be.revertedWith('failed state');
  });

  it('Non UpdaterManager cannot fail', async () => {
    await expect(
    home.connect(recipient).fail()
    ).to.be.revertedWith('!updaterManager');
  });

  it('Does not dispatch too large messages', async () => {
    const message = `0x${Buffer.alloc(3000).toString('hex')}`;
    await expect(
      home
        .dispatch(
          destDomain,
          abacus.ethersAddressToBytes32(recipient.address),
          message,
        ),
    ).to.be.revertedWith('msg too long');
  });

  it('Dispatches a message', async () => {
    const message = ethers.utils.formatBytes32String('message');
    const nonce = await home.nonces(localDomain);

    // Format data that will be emitted from Dispatch event
    const destinationAndNonce = abacus.destinationAndNonce(destDomain, nonce);

    const abacusMessage = abacus.formatMessage(
      localDomain,
      signer.address,
      nonce,
      destDomain,
      recipient.address,
      message,
    );
    const messageHash = abacus.messageHash(abacusMessage);
    const leafIndex = await home.tree();
    const [checkpointedRoot] = await home.latestCheckpoint();

    // Send message with signer address as msg.sender
    await expect(
      home
        .connect(signer)
        .dispatch(
          destDomain,
          abacus.ethersAddressToBytes32(recipient.address),
          message,
        ),
    )
      .to.emit(home, 'Dispatch')
      .withArgs(
        messageHash,
        leafIndex,
        destinationAndNonce,
        checkpointedRoot,
        abacusMessage,
      );
  });

  it('Checkpoints the latest root', async () => {
    const message = ethers.utils.formatBytes32String('message');
    await home.dispatch(
      destDomain,
      abacus.ethersAddressToBytes32(recipient.address),
      message,
    );
    await home.checkpoint();
    const [root, index] = await home.latestCheckpoint();
    expect(root).to.not.equal(nullAddress);
    expect(index).to.equal(1);
  });

  it('Correctly calculates destinationAndNonce', async () => {
    for (let testCase of destinationNonceTestCases) {
      let { destination, nonce, expectedDestinationAndNonce } = testCase;
      const solidityDestinationAndNonce = await home.destinationAndNonce(
        destination,
        nonce,
      );
      expect(solidityDestinationAndNonce).to.equal(expectedDestinationAndNonce);
    }
  });
});
