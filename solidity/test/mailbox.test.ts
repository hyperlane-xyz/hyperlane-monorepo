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
  TestIsm,
  TestIsm__factory,
  TestMailbox,
  TestMailbox__factory,
  TestRecipient__factory,
} from '../types';

import { inferMessageValues } from './lib/mailboxes';

const originDomain = 1000;
const destDomain = 2000;
const ONLY_OWNER_REVERT_MSG = 'Ownable: caller is not the owner';

describe('Mailbox', async () => {
  let mailbox: TestMailbox,
    module: TestIsm,
    signer: SignerWithAddress,
    nonOwner: SignerWithAddress;

  beforeEach(async () => {
    [signer, nonOwner] = await ethers.getSigners();
    const moduleFactory = new TestIsm__factory(signer);
    module = await moduleFactory.deploy();
    const mailboxFactory = new TestMailbox__factory(signer);
    mailbox = await mailboxFactory.deploy(originDomain);
    await mailbox.initialize(module.address);
  });

  it('Cannot be initialized twice', async () => {
    await expect(mailbox.initialize(module.address)).to.be.revertedWith(
      'Initializable: contract is already initialized',
    );
  });

  describe('#dispatch', () => {
    let recipient: SignerWithAddress, message: string, id: string, body: string;
    before(async () => {
      [, recipient] = await ethers.getSigners();
      ({ message, id, body } = await inferMessageValues(
        mailbox,
        signer.address,
        destDomain,
        recipient.address,
        'message',
      ));
    });

    it('Does not dispatch too large messages', async () => {
      const longMessage = `0x${Buffer.alloc(3000).toString('hex')}`;
      await expect(
        mailbox.dispatch(
          destDomain,
          utils.addressToBytes32(recipient.address),
          longMessage,
        ),
      ).to.be.revertedWith('msg too long');
    });

    it('Dispatches a message', async () => {
      // Send message with signer address as msg.sender
      await expect(
        mailbox
          .connect(signer)
          .dispatch(
            destDomain,
            utils.addressToBytes32(recipient.address),
            body,
          ),
      )
        .to.emit(mailbox, 'Dispatch')
        .withArgs(id, message);
    });

    it('Returns the id of the dispatched message', async () => {
      const actualId = await mailbox
        .connect(signer)
        .callStatic.dispatch(
          destDomain,
          utils.addressToBytes32(recipient.address),
          body,
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
    let message: string, id: string, recipient: string;

    beforeEach(async () => {
      await module.setAccept(true);
      const recipientF = new TestRecipient__factory(signer);
      recipient = utils.addressToBytes32((await recipientF.deploy()).address);
      ({ message, id } = await inferMessageValues(
        mailbox,
        signer.address,
        originDomain,
        recipient,
        'message',
      ));
    });

    it('processes a message', async () => {
      await expect(mailbox.process('0x', message)).to.emit(mailbox, 'Process');
      expect(await mailbox.delivered(id)).to.be.true;
    });

    it('Rejects an already-processed message', async () => {
      await expect(mailbox.process('0x', message)).to.emit(mailbox, 'Process');

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

        ({ message } = await inferMessageValues(
          mailbox,
          signer.address,
          originDomain,
          badRecipient.address,
          'message',
        ));
        await expect(mailbox.process('0x', message)).to.be.reverted;
      });
    }

    // TODO: Fails to process with wrong version..
    it('Fails to process message with wrong destination Domain', async () => {
      ({ message } = await inferMessageValues(
        mailbox,
        signer.address,
        originDomain + 1,
        recipient,
        'message',
      ));

      await expect(mailbox.process('0x', message)).to.be.revertedWith(
        '!destination',
      );
    });

    it('Fails to process message with wrong version', async () => {
      const version = await mailbox.VERSION();
      ({ message } = await inferMessageValues(
        mailbox,
        signer.address,
        originDomain,
        recipient,
        'message',
        version + 1,
      ));
      await expect(mailbox.process('0x', message)).to.be.revertedWith(
        '!version',
      );
    });

    it('Fails to process message sent to a non-existent contract address', async () => {
      ({ message } = await inferMessageValues(
        mailbox,
        signer.address,
        originDomain,
        '0x1234567890123456789012345678901234567890', // non-existent contract address
        'message',
      ));
      await expect(mailbox.process('0x', message)).to.be.reverted;
    });
  });

  describe('#setDefaultIsm', async () => {
    let newIsm: TestIsm;
    before(async () => {
      const moduleFactory = new TestIsm__factory(signer);
      newIsm = await moduleFactory.deploy();
    });

    it('Allows owner to update the default ISM', async () => {
      await expect(mailbox.setDefaultIsm(newIsm.address))
        .to.emit(mailbox, 'DefaultIsmSet')
        .withArgs(newIsm.address);
      expect(await mailbox.defaultIsm()).to.equal(newIsm.address);
    });

    it('Does not allow non-owner to update the default ISM', async () => {
      await expect(
        mailbox.connect(nonOwner).setDefaultIsm(newIsm.address),
      ).to.be.revertedWith(ONLY_OWNER_REVERT_MSG);
    });

    it('Reverts if the provided ISM is not a contract', async () => {
      await expect(mailbox.setDefaultIsm(signer.address)).to.be.revertedWith(
        '!contract',
      );
    });
  });

  describe('#pause', () => {
    it('should revert on non-owner', async () => {
      await expect(mailbox.connect(nonOwner).pause()).to.be.revertedWith(
        ONLY_OWNER_REVERT_MSG,
      );
      await expect(mailbox.connect(nonOwner).unpause()).to.be.revertedWith(
        ONLY_OWNER_REVERT_MSG,
      );
    });

    it('should emit events', async () => {
      await expect(mailbox.pause()).to.emit(mailbox, 'Paused');
      await expect(mailbox.unpause()).to.emit(mailbox, 'UnPaused');
    });

    it('should prevent dispatch and process', async () => {
      await mailbox.pause();
      await expect(
        mailbox.dispatch(
          destDomain,
          utils.addressToBytes32(nonOwner.address),
          '0x',
        ),
      ).to.be.revertedWith('!paused');
      await expect(mailbox.process('0x', '0x')).to.be.revertedWith('!paused');
    });
  });
});
