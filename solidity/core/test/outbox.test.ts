import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import { types, utils } from '@abacus-network/utils';

import { TestOutbox, TestOutbox__factory } from '../types';

const destinationNonceTestCases = require('../../../vectors/destinationNonce.json');

const localDomain = 1000;
const destDomain = 2000;

describe('Outbox', async () => {
  let outbox: TestOutbox,
    signer: SignerWithAddress,
    recipient: SignerWithAddress;

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
    expect(await outbox.state()).to.equal(types.AbacusState.FAILED);

    const message = ethers.utils.formatBytes32String('message');
    await expect(
      outbox.dispatch(
        destDomain,
        utils.addressToBytes32(recipient.address),
        message,
      ),
    ).to.be.revertedWith('failed state');
  });

  it('Non ValidatorManager cannot fail', async () => {
    await expect(outbox.connect(recipient).fail()).to.be.revertedWith(
      '!validatorManager',
    );
  });

  describe('#dispatch', () => {
    const testMessageValues = async () => {
      const message = ethers.utils.formatBytes32String('message');

      const abacusMessage = utils.formatMessage(
        localDomain,
        signer.address,
        destDomain,
        recipient.address,
        message,
      );
      const baseCommitment = await outbox.commitment();
      const messageHash = ethers.utils.solidityKeccak256(
        ['bytes'],
        [abacusMessage],
      );
      const commitment = ethers.utils.solidityKeccak256(
        ['bytes32', 'bytes32'],
        [baseCommitment, messageHash],
      );

      return {
        message,
        destDomain,
        abacusMessage,
        baseCommitment,
        commitment,
        messageHash,
      };
    };

    it('Does not dispatch too large messages', async () => {
      const message = `0x${Buffer.alloc(3000).toString('hex')}`;
      await expect(
        outbox.dispatch(
          destDomain,
          utils.addressToBytes32(recipient.address),
          message,
        ),
      ).to.be.revertedWith('msg too long');
    });

    it('Dispatches a message', async () => {
      const { message, destDomain, abacusMessage, commitment, messageHash } =
        await testMessageValues();

      // Send message with signer address as msg.sender
      console.log(message);
      await expect(
        outbox
          .connect(signer)
          .dispatch(
            destDomain,
            utils.addressToBytes32(recipient.address),
            message,
          ),
      )
        .to.emit(outbox, 'Dispatch')
        .withArgs(messageHash, commitment, destDomain, abacusMessage);
    });

    it('Returns the messsage hash of the dispatched message', async () => {
      const { message, messageHash } = await testMessageValues();

      const actual = await outbox
        .connect(signer)
        .callStatic.dispatch(
          destDomain,
          utils.addressToBytes32(recipient.address),
          message,
        );

      expect(actual).equals(messageHash);
    });
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
