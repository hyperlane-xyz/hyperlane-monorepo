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
  TestHook__factory,
  TestMailbox,
  TestMailbox__factory,
  TestMerkleTreeHook__factory,
  TestMultisigIsm,
  TestMultisigIsm__factory,
  TestRecipient,
  TestRecipient__factory,
} from '../types';

import { inferMessageValues } from './lib/mailboxes';

const originDomain = 1000;
const destDomain = 2000;
const ONLY_OWNER_REVERT_MSG = 'Ownable: caller is not the owner';

describe.skip('Mailbox', async () => {
  let mailbox: TestMailbox,
    module: TestMultisigIsm,
    signer: SignerWithAddress,
    nonOwner: SignerWithAddress,
    beforeBlock: number;

  beforeEach(async () => {
    [signer, nonOwner] = await ethers.getSigners();
    const moduleFactory = new TestMultisigIsm__factory(signer);
    module = await moduleFactory.deploy();
    const mailboxFactory = new TestMailbox__factory(signer);
    mailbox = await mailboxFactory.deploy(originDomain);
    const defaultHook = await new TestMerkleTreeHook__factory(signer).deploy(
      mailbox.address,
    );
    const requiredHook = await new TestHook__factory(signer).deploy();
    await mailbox.initialize(
      signer.address,
      module.address,
      defaultHook.address,
      requiredHook.address,
    );
    beforeBlock = mailbox.deployTransaction.blockNumber!;
  });

  it('#deployedBlock', async () => {
    const block = await mailbox.deployedBlock();
    expect(block).to.equal(beforeBlock);
  });

  it('#VERSION', async () => {
    const version = await mailbox.VERSION();
    expect(version).to.equal(3);
  });

  describe('#initialize', () => {
    it('Sets the owner', async () => {
      const owner = await mailbox.owner();
      expect(owner).equals(signer.address);
    });
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

    it('Dispatches a message', async () => {
      // Send message with signer address as msg.sender
      const recipientBytes = utils.addressToBytes32(recipient.address);
      await expect(
        mailbox
          .connect(signer)
          ['dispatch(uint32,bytes32,bytes)'](destDomain, recipientBytes, body),
      )
        .to.emit(mailbox, 'Dispatch')
        .withArgs(signer.address, destDomain, recipientBytes, message)
        .to.emit(mailbox, 'DispatchId')
        .withArgs(utils.messageId(message));
    });

    it('Returns the id of the dispatched message', async () => {
      const actualId = await mailbox
        .connect(signer)
        .callStatic['dispatch(uint32,bytes32,bytes)'](
          destDomain,
          utils.addressToBytes32(recipient.address),
          body,
        );

      expect(actualId).equals(id);
    });
  });

  describe('#recipientIsm', () => {
    let recipient: TestRecipient;
    beforeEach(async () => {
      const recipientF = new TestRecipient__factory(signer);
      recipient = await recipientF.deploy();
    });

    it('Returns the default module when unspecified', async () => {
      expect(await mailbox.recipientIsm(recipient.address)).to.equal(
        await mailbox.defaultIsm(),
      );
    });

    it('Returns the recipient module when specified', async () => {
      const recipientIsm = mailbox.address;
      await recipient.setInterchainSecurityModule(recipientIsm);
      expect(await mailbox.recipientIsm(recipient.address)).to.equal(
        recipientIsm,
      );
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
      await expect(mailbox.process('0x', message))
        .to.emit(mailbox, 'Process')
        .withArgs(
          originDomain,
          utils.addressToBytes32(signer.address),
          recipient,
        )
        .to.emit(mailbox, 'ProcessId')
        .withArgs(id);
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
        'verification failed',
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
        'Mailbox: unexpected destination',
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
        'Mailbox: bad version',
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
    let newIsm: TestMultisigIsm;
    before(async () => {
      const moduleFactory = new TestMultisigIsm__factory(signer);
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
        'Mailbox: !contract',
      );
    });
  });
});
