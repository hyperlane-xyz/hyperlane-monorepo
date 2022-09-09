import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import { types, utils } from '@abacus-network/utils';

import {
  BadRecipient1__factory,
  BadRecipient2__factory,
  BadRecipient3__factory,
  BadRecipient5__factory,
  BadRecipient6__factory,
  TestMailbox,
  TestMailbox__factory,
  TestRecipient__factory,
  TestZone,
  TestZone__factory,
} from '../types';

import { MerkleProof, dispatchMessageAndReturnProof } from './lib/mailboxes';

const localDomain = 1000;
const destDomain = 2000;
// const ONLY_OWNER_REVERT_MSG = 'Ownable: caller is not the owner';

describe('Mailbox', async () => {
  let mailbox: TestMailbox, zone: TestZone, signer: SignerWithAddress;

  before(async () => {});

  beforeEach(async () => {
    [signer] = await ethers.getSigners();
    const zoneFactory = new TestZone__factory(signer);
    zone = await zoneFactory.deploy();
    const mailboxFactory = new TestMailbox__factory(signer);
    mailbox = await mailboxFactory.deploy(localDomain);
    await mailbox.initialize(zone.address);
  });

  it('Cannot be initialized twice', async () => {
    await expect(mailbox.initialize(zone.address)).to.be.revertedWith(
      'Initializable: contract is already initialized',
    );
  });

  describe('#dispatch', () => {
    let recipient: SignerWithAddress;
    before(async () => {
      [, recipient] = await ethers.getSigners();
    });
    const testMessageValues = async () => {
      const message = ethers.utils.formatBytes32String('message');

      const abacusMessage = utils.formatMessage(
        localDomain,
        signer.address,
        destDomain,
        utils.addressToBytes32(recipient.address),
        message,
      );
      const leafIndex = await mailbox.tree();
      const hash = utils.messageHash(
        abacusMessage,
        leafIndex.toNumber(),
        utils.addressToBytes32(mailbox.address),
        await mailbox.VERSION(),
      );

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
        mailbox.dispatch(
          destDomain,
          utils.addressToBytes32(recipient.address),
          message,
        ),
      ).to.be.revertedWith('msg too long');
    });

    it('Dispatches a message', async () => {
      const { message, destDomain, abacusMessage, leafIndex } =
        await testMessageValues();

      // Send message with signer address as msg.sender
      await expect(
        mailbox
          .connect(signer)
          .dispatch(
            destDomain,
            utils.addressToBytes32(recipient.address),
            message,
          ),
      )
        .to.emit(mailbox, 'Dispatch')
        .withArgs(leafIndex, abacusMessage);
    });

    it('Returns the leaf index of the dispatched message', async () => {
      const { message, leafIndex } = await testMessageValues();

      const dispatchLeafIndex = await mailbox
        .connect(signer)
        .callStatic.dispatch(
          destDomain,
          utils.addressToBytes32(recipient.address),
          message,
        );

      expect(dispatchLeafIndex).equals(leafIndex);
    });
  });

  describe('#process', () => {
    const badRecipientFactories = [
      BadRecipient1__factory,
      BadRecipient2__factory,
      BadRecipient3__factory,
      BadRecipient5__factory,
      BadRecipient6__factory,
    ];
    let proof: MerkleProof, recipient: string, destMailbox: TestMailbox;

    beforeEach(async () => {
      await zone.setAccept(true);
      const recipientF = new TestRecipient__factory(signer);
      recipient = utils.addressToBytes32((await recipientF.deploy()).address);
      const mailboxFactory = new TestMailbox__factory(signer);
      destMailbox = await mailboxFactory.deploy(destDomain);
      await destMailbox.initialize(zone.address);
      proof = await dispatchMessageAndReturnProof(
        mailbox,
        destDomain,
        recipient,
        'hello world',
      );
    });

    it('processes a message', async () => {
      await expect(
        destMailbox.process(
          utils.addressToBytes32(mailbox.address),
          proof.root,
          proof.index,
          '0x00',
          proof.message,
          proof.proof,
          proof.index,
        ),
      ).to.emit(destMailbox, 'Process');
      expect(await destMailbox.messages(proof.leaf)).to.eql(
        types.MessageStatus.PROCESSED,
      );
    });

    it('Rejects an already-processed message', async () => {
      await destMailbox.setMessageStatus(
        proof.leaf,
        types.MessageStatus.PROCESSED,
      );

      // Try to process message again
      await expect(
        destMailbox.process(
          utils.addressToBytes32(mailbox.address),
          proof.root,
          proof.index,
          '0x00',
          proof.message,
          proof.proof,
          proof.index,
        ),
      ).to.be.revertedWith('!MessageStatus.None');
    });

    it('Rejects invalid message proof', async () => {
      // Switch ordering of proof hashes
      // NB: We copy 'path' here to avoid mutating the test cases for
      // other tests.
      const newProof = proof.proof.slice().reverse();

      expect(
        destMailbox.process(
          utils.addressToBytes32(mailbox.address),
          proof.root,
          proof.index,
          '0x00',
          proof.message,
          newProof,
          proof.index,
        ),
      ).to.be.revertedWith('!proof');
      expect(await destMailbox.messages(proof.leaf)).to.equal(
        types.MessageStatus.NONE,
      );
    });

    it('Fails to process message when rejected by zone', async () => {
      await zone.setAccept(false);
      await expect(
        destMailbox.process(
          utils.addressToBytes32(mailbox.address),
          proof.root,
          proof.index,
          '0x00',
          proof.message,
          proof.proof,
          proof.index,
        ),
      ).to.be.revertedWith('!zone');
    });

    for (let i = 0; i < badRecipientFactories.length; i++) {
      it(`Fails to process a message for a badly implemented recipient (${
        i + 1
      })`, async () => {
        const factory = new badRecipientFactories[i](signer);
        const badRecipient = await factory.deploy();

        const badProof = await dispatchMessageAndReturnProof(
          mailbox,
          destDomain,
          utils.addressToBytes32(badRecipient.address),
          'hello world',
        );

        await expect(
          destMailbox.process(
            utils.addressToBytes32(mailbox.address),
            badProof.root,
            badProof.index,
            '0x00',
            badProof.message,
            badProof.proof,
            badProof.index,
          ),
        ).to.be.reverted;
      });
    }

    it('Fails to process message with wrong destination Domain', async () => {
      const badProof = await dispatchMessageAndReturnProof(
        mailbox,
        destDomain + 1,
        recipient,
        'hello world',
      );

      await expect(
        destMailbox.process(
          utils.addressToBytes32(mailbox.address),
          badProof.root,
          badProof.index,
          '0x00',
          badProof.message,
          badProof.proof,
          badProof.index,
        ),
      ).to.be.revertedWith('!destination');
    });

    it('Fails to process message sent to a non-existent contract address', async () => {
      const badProof = await dispatchMessageAndReturnProof(
        mailbox,
        destDomain,
        utils.addressToBytes32('0x1234567890123456789012345678901234567890'), // non-existent contract address
        'hello world',
      );
      await expect(
        destMailbox.process(
          utils.addressToBytes32(mailbox.address),
          badProof.root,
          badProof.index,
          '0x00',
          badProof.message,
          badProof.proof,
          badProof.index,
        ),
      ).to.be.reverted;
    });
  });

  /*
  describe('#setValidatorManager', async () => {
    it('Allows owner to update the ValidatorManager', async () => {
      const mailboxFactory = new TestMailbox__factory(owner);
      const newValidatorManager = await mailboxFactory.deploy(localDomain);
      await expect(
        mailbox.setValidatorManager(newValidatorManager.address),
      ).to.emit(mailbox, 'ValidatorManagerSet');
      expect(await mailbox.validatorManager()).to.equal(
        newValidatorManager.address,
      );
    });

    it('Does not allow nonowner to update the ValidatorManager', async () => {
      await expect(
        mailbox.connect(nonowner).setValidatorManager(mailbox.address),
      ).to.be.revertedWith(ONLY_OWNER_REVERT_MSG);
    });
  });
  */
});
