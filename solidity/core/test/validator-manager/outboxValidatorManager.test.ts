import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import { Validator, types, utils } from '@abacus-network/utils';
import { BytesArray } from '@abacus-network/utils/dist/src/types';

import {
  OutboxValidatorManager,
  OutboxValidatorManager__factory,
  TestOutbox,
  TestOutbox__factory,
} from '../../types';

import { signCheckpoint } from './utils';

const OUTBOX_DOMAIN = 1234;
const INBOX_DOMAIN = 4321;
const QUORUM_THRESHOLD = 2;

describe('OutboxValidatorManager', () => {
  let validatorManager: OutboxValidatorManager,
    outbox: TestOutbox,
    signer: SignerWithAddress,
    validator0: Validator,
    validator1: Validator;

  before(async () => {
    const signers = await ethers.getSigners();
    signer = signers[0];
    validator0 = await Validator.fromSigner(signers[1], OUTBOX_DOMAIN);
    validator1 = await Validator.fromSigner(signers[2], OUTBOX_DOMAIN);
  });

  beforeEach(async () => {
    const validatorManagerFactory = new OutboxValidatorManager__factory(signer);
    validatorManager = await validatorManagerFactory.deploy(
      OUTBOX_DOMAIN,
      [validator0.address, validator1.address],
      QUORUM_THRESHOLD,
    );

    const outboxFactory = new TestOutbox__factory(signer);
    outbox = await outboxFactory.deploy(OUTBOX_DOMAIN);
    await outbox.initialize(validatorManager.address);
  });

  describe('#invalidCheckpoint', () => {
    const messageCount = 1;
    // An invalid checkpoint is one that has index greater than the latest index
    // in the Outbox.
    const invalidIndex = messageCount;
    const root = ethers.utils.formatBytes32String('test root');

    beforeEach(async () => {
      const message = ethers.utils.formatBytes32String('message');
      const recipient = utils.addressToBytes32(validator0.address);
      const destination = INBOX_DOMAIN;
      for (let i = 0; i < messageCount; i++) {
        await outbox.dispatch(destination, recipient, message);
      }
    });

    it('accepts an invalid checkpoint if it has been signed by a quorum of validators', async () => {
      const signatures = await signCheckpoint(
        root,
        invalidIndex,
        [validator0, validator1], // 2/2 signers is a quorum
      );

      await expect(
        validatorManager.invalidCheckpoint(
          outbox.address,
          root,
          invalidIndex,
          signatures,
        ),
      )
        .to.emit(validatorManager, 'InvalidCheckpoint')
        .withArgs(outbox.address, root, invalidIndex, signatures);
      expect(await outbox.state()).to.equal(types.AbacusState.FAILED);
    });

    it('reverts if an invalid checkpoint has not been signed a quorum of validators', async () => {
      const signatures = await signCheckpoint(
        root,
        invalidIndex,
        [validator0], // 1/2 signers is not a quorum
      );

      await expect(
        validatorManager.invalidCheckpoint(
          outbox.address,
          root,
          invalidIndex,
          signatures,
        ),
      ).to.be.revertedWith('!quorum');
    });

    it('reverts if a valid checkpoint has been signed by a quorum of validators', async () => {
      const validIndex = messageCount - 1;
      const signatures = await signCheckpoint(
        root,
        validIndex,
        [validator0, validator1], // 2/2 signers is a quorum
      );

      await expect(
        validatorManager.invalidCheckpoint(
          outbox.address,
          root,
          validIndex,
          signatures,
        ),
      ).to.be.revertedWith('!invalid');
    });
  });

  describe('#fraudulentCheckpoint', async () => {
    interface MerkleProof {
      root: string;
      proof: BytesArray;
      leaf: string;
      index: number;
    }

    let actual: MerkleProof, fraudulent: MerkleProof;
    const disputedIndex = 2;

    beforeEach(async () => {
      // Deploy a second Outbox for convenience. We push a fraudulent message to this Outbox
      // and use it to generate a fraudulent merkle proof.
      const outboxFactory = new TestOutbox__factory(signer);
      const fraudulentOutbox = await outboxFactory.deploy(OUTBOX_DOMAIN);
      await fraudulentOutbox.initialize(validatorManager.address);

      const actualMessage = ethers.utils.formatBytes32String('message');
      const fraudulentMessage = ethers.utils.formatBytes32String('fraud');
      const recipient = utils.addressToBytes32(validator0.address);
      const destination = INBOX_DOMAIN;

      for (let i = 0; i < disputedIndex; i++) {
        await outbox.dispatch(destination, recipient, actualMessage);
        await fraudulentOutbox.dispatch(destination, recipient, actualMessage);
      }

      const getProofForDispatchedMessage = async (
        outbox: TestOutbox,
        message: string,
      ) => {
        await outbox.dispatch(destination, recipient, message);
        const formattedMessage = utils.formatMessage(
          OUTBOX_DOMAIN,
          signer.address,
          destination,
          recipient,
          message,
        );
        const count = await outbox.count();
        const leaf = utils.messageHash(
          formattedMessage,
          count.sub(1).toNumber(),
        );
        const root = await outbox.root();
        const proof = await outbox.proof();
        return {
          root,
          proof,
          leaf,
          index: count.sub(1).toNumber(),
        };
      };

      actual = await getProofForDispatchedMessage(outbox, actualMessage);
      fraudulent = await getProofForDispatchedMessage(
        fraudulentOutbox,
        fraudulentMessage,
      );
    });

    it('accepts a valid fraud proof if signed by quourm', async () => {
      await outbox.cacheCheckpoint();
      const signatures = await signCheckpoint(
        fraudulent.root,
        fraudulent.index,
        [validator0, validator1], // 2/2 signers is a quorum
      );

      await expect(
        validatorManager.fraudulentCheckpoint(
          outbox.address,
          fraudulent.root,
          fraudulent.index,
          signatures,
          fraudulent.leaf,
          fraudulent.proof,
          actual.leaf,
          actual.proof,
          fraudulent.index,
        ),
      )
        .to.emit(validatorManager, 'FraudulentCheckpoint')
        .withArgs(
          outbox.address,
          fraudulent.root,
          fraudulent.index,
          signatures,
        );
      expect(await outbox.state()).to.equal(types.AbacusState.FAILED);
    });

    it('reverts if a valid fraud proof if not signed by quorum', async () => {
      await outbox.cacheCheckpoint();
      const signatures = await signCheckpoint(
        fraudulent.root,
        fraudulent.index,
        [validator0], // 1/2 signers is not a quorum
      );

      await expect(
        validatorManager.fraudulentCheckpoint(
          outbox.address,
          fraudulent.root,
          fraudulent.index,
          signatures,
          fraudulent.leaf,
          fraudulent.proof,
          actual.leaf,
          actual.proof,
          fraudulent.index,
        ),
      ).to.be.revertedWith('!quorum');
    });

    it('reverts if the signed root is not fraudulent', async () => {
      await outbox.cacheCheckpoint();
      const signatures = await signCheckpoint(
        actual.root,
        actual.index,
        [validator0, validator1], // 2/2 signers is a quorum
      );

      await expect(
        validatorManager.fraudulentCheckpoint(
          outbox.address,
          actual.root,
          actual.index,
          signatures,
          fraudulent.leaf,
          fraudulent.proof,
          actual.leaf,
          actual.proof,
          fraudulent.index,
        ),
      ).to.be.revertedWith('!roots');
    });

    it('reverts if the actual root is not cached', async () => {
      const signatures = await signCheckpoint(
        fraudulent.root,
        fraudulent.index,
        [validator0, validator1], // 2/2 signers is a quorum
      );

      await expect(
        validatorManager.fraudulentCheckpoint(
          outbox.address,
          fraudulent.root,
          fraudulent.index,
          signatures,
          fraudulent.leaf,
          fraudulent.proof,
          actual.leaf,
          actual.proof,
          fraudulent.index,
        ),
      ).to.be.revertedWith('!cache');
    });

    it('reverts if the disputed leaves are not different', async () => {
      await outbox.cacheCheckpoint();
      const signatures = await signCheckpoint(
        actual.root,
        actual.index,
        [validator0, validator1], // 2/2 signers is a quorum
      );

      await expect(
        validatorManager.fraudulentCheckpoint(
          outbox.address,
          actual.root,
          actual.index,
          signatures,
          actual.leaf,
          actual.proof,
          actual.leaf,
          actual.proof,
          actual.index,
        ),
      ).to.be.revertedWith('!leaves');
    });
  });
});
