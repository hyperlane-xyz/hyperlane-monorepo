import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { ethers } from 'hardhat';

import { types, utils } from '@abacus-network/utils';

import {
  TestBN256__factory,
  TestOutbox,
  TestOutbox__factory,
  ValidatorManager,
  ValidatorManager__factory,
} from '../types';

import { DispatchReturnValues, dispatchMessage } from './lib/mailboxes';
import { ValidatorSet } from './lib/validators';

const localDomain = 1000;
const destDomain = 2000;
const SET_SIZE = 32;

describe('Outbox', async () => {
  let outbox: TestOutbox,
    helper: TestOutbox,
    validatorManager: ValidatorManager,
    validators: ValidatorSet,
    signer: SignerWithAddress,
    recipient: SignerWithAddress;

  before(async () => {
    [signer, recipient] = await ethers.getSigners();
  });

  beforeEach(async () => {
    // redeploy the outbox before each test run
    const outboxFactory = new TestOutbox__factory(signer);
    outbox = await outboxFactory.deploy(localDomain);

    const validatorManagerFactory = new ValidatorManager__factory(signer);
    validatorManager = await validatorManagerFactory.deploy();

    const domainHash = await outbox.domainHash();

    const bn256Factory = new TestBN256__factory(signer);
    const bn256 = await bn256Factory.deploy();

    // Create and enroll validators
    validators = new ValidatorSet(SET_SIZE, bn256, domainHash);
    await validators.enroll(localDomain, validatorManager);

    await outbox.initialize(validatorManager.address);

    helper = await outboxFactory.deploy(localDomain);
  });

  it('Cannot be initialized twice', async () => {
    await expect(outbox.initialize(outbox.address)).to.be.revertedWith(
      'Initializable: contract is already initialized',
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
      const leafIndex = await outbox.tree();
      const hash = utils.messageHash(abacusMessage, leafIndex.toNumber());

      return {
        message,
        destDomain,
        abacusMessage,
        hash,
        leafIndex,
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
      ).to.be.revertedWith('msglen');
    });

    it('Dispatches a message', async () => {
      const { message, destDomain, abacusMessage, leafIndex } =
        await testMessageValues();

      // Send message with signer address as msg.sender
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
        .withArgs(leafIndex, abacusMessage);
    });

    it('Returns the leaf index of the dispatched message', async () => {
      const { message, leafIndex } = await testMessageValues();

      const dispatchLeafIndex = await outbox
        .connect(signer)
        .callStatic.dispatch(
          destDomain,
          utils.addressToBytes32(recipient.address),
          message,
        );

      expect(dispatchLeafIndex).equals(leafIndex);
    });

    it('Reverts if in a failed state', async () => {
      await outbox.testFail();
      const { message, destDomain } = await testMessageValues();

      await expect(
        outbox.dispatch(
          destDomain,
          utils.addressToBytes32(recipient.address),
          message,
        ),
      ).to.be.revertedWith('failed');
    });
  });

  describe('#cacheCheckpoint', () => {
    it('Caches a checkpoint', async () => {
      const message = ethers.utils.formatBytes32String('message');
      const count = 2;
      for (let i = 0; i < count; i++) {
        await outbox.dispatch(
          destDomain,
          utils.addressToBytes32(recipient.address),
          message,
        );
      }
      await outbox.cacheCheckpoint();
      const root = await outbox.latestCachedRoot();
      expect(root).to.not.equal(ethers.constants.HashZero);
      expect(await outbox.cachedCheckpoints(root)).to.equal(count - 1);
    });

    it('does not allow caching a checkpoint with index 0', async () => {
      const message = ethers.utils.formatBytes32String('message');
      await outbox.dispatch(
        destDomain,
        utils.addressToBytes32(recipient.address),
        message,
      );
      await expect(outbox.cacheCheckpoint()).to.be.revertedWith('!index');
    });
  });

  describe('#prematureCheckpoint', () => {
    it('fails when presented with a premature checkpoint signed by a quorum of validators', async () => {
      const checkpoint = {
        root: await outbox.root(),
        index: BigNumber.from(1000),
      };
      const signature = await validators.sign(checkpoint);
      await expect(outbox.prematureCheckpoint(signature, checkpoint)).to.emit(
        outbox,
        'PrematureCheckpoint',
      );
      expect(await outbox.state()).to.equal(types.AbacusState.FAILED);
    });

    it('reverts when presented with a valid checkpoint signed by a quorum of validators', async () => {
      // Dispatch a single message so that a checkpoint with an index of 0 is not premature
      await dispatchMessage(
        outbox,
        destDomain,
        utils.addressToBytes32(recipient.address),
        'test',
      );
      const checkpoint = {
        root: await outbox.root(),
        index: BigNumber.from(0),
      };
      const signature = await validators.sign(checkpoint);
      await expect(
        outbox.prematureCheckpoint(signature, checkpoint),
      ).to.be.revertedWith('!premature');
      expect(await outbox.state()).to.equal(types.AbacusState.ACTIVE);
    });
  });

  const dispatchMessagesAndReturnProofs = async (args: {
    differingIndex: number;
    proofIndex: number;
    messageCount: number;
  }) => {
    const mrecipient = utils.addressToBytes32(recipient.address);
    const { differingIndex, proofIndex, messageCount } = args;
    const actualMessage = 'message';
    const fraudulentMessage = 'fraud';
    let index = 0;
    const helperMessage = (j: number) =>
      j === differingIndex ? fraudulentMessage : actualMessage;
    for (; index < proofIndex; index++) {
      await dispatchMessage(outbox, destDomain, mrecipient, actualMessage);
      await dispatchMessage(
        helper,
        destDomain,
        mrecipient,
        helperMessage(index),
      );
    }
    const proofA = await dispatchMessage(
      outbox,
      destDomain,
      mrecipient,
      actualMessage,
    );
    const proofB = await dispatchMessage(
      helper,
      destDomain,
      mrecipient,
      helperMessage(proofIndex),
    );
    for (index = proofIndex + 1; index < messageCount; index++) {
      await dispatchMessage(outbox, destDomain, mrecipient, actualMessage);
      await dispatchMessage(
        helper,
        destDomain,
        mrecipient,
        helperMessage(index),
      );
    }

    return { proofA, proofB };
  };

  describe('#impliesDifferingLeaf', async () => {
    it('returns true when proving a leaf with index greater than the differing leaf', async () => {
      const { proofA, proofB } = await dispatchMessagesAndReturnProofs({
        differingIndex: 3,
        proofIndex: 4,
        messageCount: 5,
      });
      expect(await outbox.impliesDifferingLeaf(proofA.proof, proofB.proof)).to
        .be.true;
    });

    it('returns true when proving a leaf with index equal to the differing leaf', async () => {
      const { proofA, proofB } = await dispatchMessagesAndReturnProofs({
        differingIndex: 4,
        proofIndex: 4,
        messageCount: 5,
      });
      expect(await outbox.impliesDifferingLeaf(proofA.proof, proofB.proof)).to
        .be.true;
    });

    it('returns false when proving a leaf with index less than the differing leaf', async () => {
      const { proofA, proofB } = await dispatchMessagesAndReturnProofs({
        differingIndex: 4,
        proofIndex: 3,
        messageCount: 5,
      });
      expect(await outbox.impliesDifferingLeaf(proofA.proof, proofB.proof)).to
        .be.false;
    });
  });

  describe('#fraudulentCheckpoint', async () => {
    let actual: DispatchReturnValues, fraudulent: DispatchReturnValues;

    beforeEach(async () => {
      const { proofA, proofB } = await dispatchMessagesAndReturnProofs({
        differingIndex: 3,
        proofIndex: 4,
        messageCount: 5,
      });
      actual = proofA;
      fraudulent = proofB;
    });

    it('accepts a fraud proof signed by a quorum', async () => {
      await outbox.cacheCheckpoint();
      const signatures = await validators.sign(fraudulent.checkpoint);

      await expect(
        outbox.fraudulentCheckpoint(
          signatures,
          fraudulent.checkpoint,
          fraudulent.proof,
          actual.proof,
        ),
      ).to.emit(outbox, 'FraudulentCheckpoint');
      expect(await outbox.state()).to.equal(types.AbacusState.FAILED);
    });

    it('reverts if a fraud proof is not signed by a quorum', async () => {
      await outbox.cacheCheckpoint();
      const signatures = await validators.sign(fraudulent.checkpoint, 1);

      await expect(
        outbox.fraudulentCheckpoint(
          signatures,
          fraudulent.checkpoint,
          fraudulent.proof,
          actual.proof,
        ),
      ).to.be.revertedWith('!threshold');
    });

    it('reverts if the signed root is not fraudulent', async () => {
      await outbox.cacheCheckpoint();
      const signatures = await validators.sign(actual.checkpoint);

      await expect(
        outbox.fraudulentCheckpoint(
          signatures,
          actual.checkpoint,
          fraudulent.proof,
          actual.proof,
        ),
      ).to.be.revertedWith('!root');
    });

    it('reverts if the disputed leaf is not committed to by the signed checkpoint', async () => {
      await outbox.cacheCheckpoint();
      const otherCheckpoint = {
        root: fraudulent.checkpoint.root,
        index: fraudulent.checkpoint.index.sub(1),
      };
      const signatures = await validators.sign(otherCheckpoint);

      await expect(
        outbox.fraudulentCheckpoint(
          signatures,
          otherCheckpoint,
          fraudulent.proof,
          actual.proof,
        ),
      ).to.be.revertedWith('!index');
    });

    it('reverts if the actual root is not cached', async () => {
      const signatures = await validators.sign(fraudulent.checkpoint);

      await expect(
        outbox.fraudulentCheckpoint(
          signatures,
          fraudulent.checkpoint,
          fraudulent.proof,
          actual.proof,
        ),
      ).to.be.revertedWith('!cache');
    });

    it('reverts if the root is not fraudulent', async () => {
      await outbox.cacheCheckpoint();
      const signatures = await validators.sign(actual.checkpoint);

      await expect(
        outbox.fraudulentCheckpoint(
          signatures,
          actual.checkpoint,
          actual.proof,
          actual.proof,
        ),
      ).to.be.revertedWith('!fraud');
    });
  });
});
