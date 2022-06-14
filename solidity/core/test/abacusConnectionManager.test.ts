import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import {
  AbacusConnectionManager,
  AbacusConnectionManager__factory,
  Outbox,
  Outbox__factory,
  TestInbox,
  TestInbox__factory,
} from '../types';

const ONLY_OWNER_REVERT_MSG = 'Ownable: caller is not the owner';
const localDomain = 1000;
const remoteDomain = 2000;

describe('AbacusConnectionManager', async () => {
  let connectionManager: AbacusConnectionManager,
    enrolledInbox: TestInbox,
    signer: SignerWithAddress,
    nonOwner: SignerWithAddress;

  before(async () => {
    [signer, nonOwner] = await ethers.getSigners();
  });

  beforeEach(async () => {
    const outboxFactory = new Outbox__factory(signer);
    const outbox = await outboxFactory.deploy(localDomain);

    const inboxFactory = new TestInbox__factory(signer);
    enrolledInbox = await inboxFactory.deploy(localDomain);
    // The ValidatorManager is unused in these tests *but* needs to be a
    // contract.
    await enrolledInbox.initialize(remoteDomain, outbox.address);

    const connectionManagerFactory = new AbacusConnectionManager__factory(
      signer,
    );
    connectionManager = await connectionManagerFactory.deploy();
    await connectionManager.setOutbox(outbox.address);
    await connectionManager.enrollInbox(remoteDomain, enrolledInbox.address);
  });

  it('Returns the local domain', async () => {
    expect(await connectionManager!.localDomain()).to.equal(localDomain);
  });

  describe('#setOutbox', () => {
    let newOutbox: Outbox;

    beforeEach(async () => {
      const outboxFactory = new Outbox__factory(signer);
      newOutbox = await outboxFactory.deploy(localDomain);
    });

    it('Allows owner to set the outbox', async () => {
      await connectionManager.setOutbox(newOutbox.address);
      expect(await connectionManager.outbox()).to.equal(newOutbox.address);
    });

    it('Emits the OutboxSet event', async () => {
      await expect(connectionManager.setOutbox(newOutbox.address))
        .to.emit(connectionManager, 'OutboxSet')
        .withArgs(newOutbox.address);
    });

    it('Reverts a call from non-owner', async () => {
      await expect(
        connectionManager.connect(nonOwner).setOutbox(newOutbox.address),
      ).to.be.revertedWith(ONLY_OWNER_REVERT_MSG);
    });
  });

  it('isInbox returns true for enrolledInbox and false for non-enrolled Inbox', async () => {
    const [nonEnrolledInbox] = await ethers.getSigners();
    expect(await connectionManager.isInbox(enrolledInbox.address)).to.be.true;
    expect(await connectionManager.isInbox(nonEnrolledInbox.address)).to.be
      .false;
  });

  it('Owner can enroll a inbox', async () => {
    const newRemoteDomain = 3000;
    const inboxFactory = new TestInbox__factory(signer);
    const newInbox = await inboxFactory.deploy(localDomain);

    // Assert new inbox not considered inbox before enrolled
    expect(await connectionManager.isInbox(newInbox.address)).to.be.false;

    await expect(
      connectionManager.enrollInbox(newRemoteDomain, newInbox.address),
    ).to.emit(connectionManager, 'InboxEnrolled');

    expect(await connectionManager.getInboxes(newRemoteDomain)).to.eql([
      newInbox.address,
    ]);
    expect(await connectionManager.inboxToDomain(newInbox.address)).to.equal(
      newRemoteDomain,
    );
    expect(await connectionManager.isInbox(newInbox.address)).to.be.true;
  });

  it('Owner can unenroll a inbox', async () => {
    expect(await connectionManager.getInboxes(remoteDomain)).to.eql([
      enrolledInbox.address,
    ]);
    await expect(
      connectionManager.unenrollInbox(enrolledInbox.address),
    ).to.emit(connectionManager, 'InboxUnenrolled');

    expect(
      await connectionManager.inboxToDomain(enrolledInbox.address),
    ).to.equal(0);
    expect(await connectionManager.getInboxes(remoteDomain)).to.eql([]);
    expect(await connectionManager.isInbox(enrolledInbox.address)).to.be.false;
  });

  it('Owner can enroll multiple inboxes per domain', async () => {
    const newRemoteDomain = 3000;
    const inboxFactory = new TestInbox__factory(signer);
    const newInbox1 = await inboxFactory.deploy(localDomain);
    const newInbox2 = await inboxFactory.deploy(localDomain);

    // Assert new inbox not considered inbox before enrolled
    expect(await connectionManager.isInbox(newInbox1.address)).to.be.false;
    expect(await connectionManager.isInbox(newInbox2.address)).to.be.false;

    await expect(
      connectionManager.enrollInbox(newRemoteDomain, newInbox1.address),
    ).to.emit(connectionManager, 'InboxEnrolled');
    await expect(
      connectionManager.enrollInbox(newRemoteDomain, newInbox2.address),
    ).to.emit(connectionManager, 'InboxEnrolled');

    expect(await connectionManager.inboxToDomain(newInbox1.address)).to.equal(
      newRemoteDomain,
    );
    expect(await connectionManager.inboxToDomain(newInbox2.address)).to.equal(
      newRemoteDomain,
    );

    expect(await connectionManager.isInbox(newInbox1.address)).to.be.true;
    expect(await connectionManager.isInbox(newInbox2.address)).to.be.true;

    expect(await connectionManager.getInboxes(newRemoteDomain)).to.eql([
      newInbox1.address,
      newInbox2.address,
    ]);
  });

  it('Owner cannot enroll an inbox twice', async () => {
    const newRemoteDomain = 3000;
    await expect(
      connectionManager.enrollInbox(newRemoteDomain, enrolledInbox.address),
    ).to.be.revertedWith('already inbox');
  });
});
