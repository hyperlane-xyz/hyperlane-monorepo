import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import {
  InterchainGasPaymaster,
  InterchainGasPaymaster__factory,
  Mailbox,
  Mailbox__factory,
} from '../types';
import {
  TestHyperlaneConnectionClient,
  TestHyperlaneConnectionClient__factory,
} from '../types';

const ONLY_OWNER_REVERT_MSG = 'Ownable: caller is not the owner';

describe('HyperlaneConnectionClient', async () => {
  let connectionClient: TestHyperlaneConnectionClient,
    mailbox: Mailbox,
    newMailbox: Mailbox,
    signer: SignerWithAddress,
    nonOwner: SignerWithAddress;

  before(async () => {
    [signer, nonOwner] = await ethers.getSigners();
  });

  beforeEach(async () => {
    const mailboxFactory = new Mailbox__factory(signer);
    const domain = 1000;
    mailbox = await mailboxFactory.deploy(domain);
    newMailbox = await mailboxFactory.deploy(domain);

    const connectionClientFactory = new TestHyperlaneConnectionClient__factory(
      signer,
    );
    connectionClient = await connectionClientFactory.deploy();
    await connectionClient.initialize(mailbox.address);
  });

  it('Cannot be initialized twice', async () => {
    await expect(
      connectionClient.initialize(mailbox.address),
    ).to.be.revertedWith('Initializable: contract is already initialized');
  });

  it('owner can set mailbox', async () => {
    expect(await connectionClient.mailbox()).to.not.equal(newMailbox.address);
    await expect(connectionClient.setMailbox(newMailbox.address)).to.emit(
      connectionClient,
      'MailboxSet',
    );
    expect(await connectionClient.mailbox()).to.equal(newMailbox.address);
  });

  it('non-owner cannot set mailbox', async () => {
    await expect(
      connectionClient.connect(nonOwner).setMailbox(newMailbox.address),
    ).to.be.revertedWith(ONLY_OWNER_REVERT_MSG);
  });

  describe('#setInterchainGasPaymaster', () => {
    let newPaymaster: InterchainGasPaymaster;

    before(async () => {
      const paymasterFactory = new InterchainGasPaymaster__factory(signer);
      newPaymaster = await paymasterFactory.deploy(signer.address);
    });

    it('Allows owner to set the interchainGasPaymaster', async () => {
      await connectionClient.setInterchainGasPaymaster(newPaymaster.address);
      expect(await connectionClient.interchainGasPaymaster()).to.equal(
        newPaymaster.address,
      );
    });

    it('Emits the SetInterchainGasPaymaster event', async () => {
      await expect(
        connectionClient.setInterchainGasPaymaster(newPaymaster.address),
      )
        .to.emit(connectionClient, 'InterchainGasPaymasterSet')
        .withArgs(newPaymaster.address);
    });

    it('Reverts a call from non-owner', async () => {
      await expect(
        connectionClient
          .connect(nonOwner)
          .setInterchainGasPaymaster(newPaymaster.address),
      ).to.be.revertedWith(ONLY_OWNER_REVERT_MSG);
    });
  });
});
