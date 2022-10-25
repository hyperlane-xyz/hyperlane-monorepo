import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import { utils } from '@hyperlane-xyz/utils';

import {
  BadRecipient1__factory,
  BadRecipient2__factory,
  BadRecipient3__factory,
  BadRecipient5__factory,
  BadRecipient6__factory,
  TestMailbox,
  TestMailbox__factory,
  TestModule,
  TestModule__factory,
  TestRecipient__factory,
} from '../types';

import { dispatchMessage } from './lib/mailboxes';

const localDomain = 1000;
const destDomain = 2000;
const version = 0;
// const ONLY_OWNER_REVERT_MSG = 'Ownable: caller is not the owner';

describe('Mailbox', async () => {
  let mailbox: TestMailbox, module: TestModule, signer: SignerWithAddress;

  before(async () => {});

  beforeEach(async () => {
    [signer] = await ethers.getSigners();
    const moduleFactory = new TestModule__factory(signer);
    module = await moduleFactory.deploy();
    const mailboxFactory = new TestMailbox__factory(signer);
    mailbox = await mailboxFactory.deploy(localDomain, version);
    await mailbox.initialize(module.address);
  });

  it('Cannot be initialized twice', async () => {
    await expect(mailbox.initialize(module.address)).to.be.revertedWith(
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

      const nonce = await mailbox.count();
      const hyperlaneMessage = utils.formatMessage(
        nonce,
        version,
        localDomain,
        signer.address,
        destDomain,
        utils.addressToBytes32(recipient.address),
        message,
      );
      const id = utils.messageId(hyperlaneMessage);

      return {
        message,
        destDomain,
        hyperlaneMessage,
        id,
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
      const { message, destDomain, hyperlaneMessage, id } =
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
        .withArgs(id, hyperlaneMessage);
    });

    it('Returns the leaf index of the dispatched message', async () => {
      const { message, id } = await testMessageValues();

      const actualId = await mailbox
        .connect(signer)
        .callStatic.dispatch(
          destDomain,
          utils.addressToBytes32(recipient.address),
          message,
        );

      expect(actualId).equals(id);
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
    let message: string, messageId: string, recipient: string;

    beforeEach(async () => {
      await module.setAccept(true);
      const recipientF = new TestRecipient__factory(signer);
      recipient = utils.addressToBytes32((await recipientF.deploy()).address);
      ({ message, messageId } = await dispatchMessage(
        mailbox,
        localDomain,
        recipient,
        'hello world',
      ));
    });

    it('processes a message', async () => {
      await expect(mailbox.process('0x', message)).to.emit(mailbox, 'Process');
      expect(await mailbox.delivered(messageId)).to.be.true;
    });

    it('Rejects an already-processed message', async () => {
      await mailbox.setMessageDelivered(messageId, true);

      // Try to process message again
      await expect(mailbox.process('0x', message)).to.be.revertedWith(
        'delivered',
      );
    });

    it('Fails to process message when rejected by module', async () => {
      await module.setAccept(false);
      await expect(mailbox.process('0x', message)).to.be.revertedWith(
        '!module',
      );
    });

    for (let i = 0; i < badRecipientFactories.length; i++) {
      it(`Fails to process a message for a badly implemented recipient (${
        i + 1
      })`, async () => {
        const factory = new badRecipientFactories[i](signer);
        const badRecipient = await factory.deploy();

        let { message } = await dispatchMessage(
          mailbox,
          destDomain,
          utils.addressToBytes32(badRecipient.address),
          'hello world',
        );

        await expect(mailbox.process('0x', message)).to.be.reverted;
      });
    }

    it('Fails to process message with wrong destination Domain', async () => {
      let { message } = await dispatchMessage(
        mailbox,
        destDomain + 1,
        recipient,
        'hello world',
      );

      await expect(mailbox.process('0x', message)).to.be.revertedWith(
        '!destination',
      );
    });

    it('Fails to process message sent to a non-existent contract address', async () => {
      let { message } = await dispatchMessage(
        mailbox,
        destDomain,
        utils.addressToBytes32('0x1234567890123456789012345678901234567890'), // non-existent contract address
        'hello world',
      );
      await expect(mailbox.process('0x', message)).to.be.reverted;
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
