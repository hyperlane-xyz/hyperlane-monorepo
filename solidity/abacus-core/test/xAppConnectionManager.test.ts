import { ethers } from 'hardhat';
import { expect } from 'chai';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';

import {
  TestOutbox__factory,
  TestInbox__factory,
  XAppConnectionManager,
  XAppConnectionManager__factory,
  TestInbox,
} from '../types';

const ONLY_OWNER_REVERT_MSG = 'Ownable: caller is not the owner';
const localDomain = 1000;
const remoteDomain = 2000;
const processGas = 850000;
const reserveGas = 15000;

describe('XAppConnectionManager', async () => {
  let connectionManager: XAppConnectionManager,
    enrolledInbox: TestInbox,
    signer: SignerWithAddress;

  before(async () => {
    [signer] = await ethers.getSigners();
  });

  beforeEach(async () => {
    const outboxFactory = new TestOutbox__factory(signer);
    const outbox = await outboxFactory.deploy(localDomain);

    const inboxFactory = new TestInbox__factory(signer);
    enrolledInbox = await inboxFactory.deploy(
      localDomain,
      processGas,
      reserveGas,
    );
    // The ValidatorManager is unused in these tests *but* needs to be a
    // contract.
    await enrolledInbox.initialize(
      remoteDomain,
      outbox.address,
      ethers.constants.HashZero,
      0,
    );

    const connectionManagerFactory = new XAppConnectionManager__factory(signer);
    connectionManager = await connectionManagerFactory.deploy();
    await connectionManager.setOutbox(outbox.address);
    await connectionManager.enrollInbox(remoteDomain, enrolledInbox.address);
  });

  it('Returns the local domain', async () => {
    expect(await connectionManager!.localDomain()).to.equal(localDomain);
  });

  it('onlyOwner function rejects call from non-owner', async () => {
    const [nonOutbox, nonOwner] = await ethers.getSigners();
    await expect(
      connectionManager.connect(nonOwner).setOutbox(nonOutbox.address),
    ).to.be.revertedWith(ONLY_OWNER_REVERT_MSG);
  });

  it('isInbox returns true for enrolledInbox and false for non-enrolled Inbox', async () => {
    const [nonEnrolledInbox] = await ethers.getSigners();
    expect(await connectionManager.isInbox(enrolledInbox.address)).to.be.true;
    expect(await connectionManager.isInbox(nonEnrolledInbox.address)).to.be
      .false;
  });

  it('Allows owner to set the outbox', async () => {
    const outboxFactory = new TestOutbox__factory(signer);
    const newOutbox = await outboxFactory.deploy(localDomain);

    await connectionManager.setOutbox(newOutbox.address);
    expect(await connectionManager.outbox()).to.equal(newOutbox.address);
  });

  it('Owner can enroll a inbox', async () => {
    const newRemoteDomain = 3000;
    const inboxFactory = new TestInbox__factory(signer);
    const newInbox = await inboxFactory.deploy(
      localDomain,
      processGas,
      reserveGas,
    );

    // Assert new inbox not considered inbox before enrolled
    expect(await connectionManager.isInbox(newInbox.address)).to.be.false;

    await expect(
      connectionManager.enrollInbox(newRemoteDomain, newInbox.address),
    ).to.emit(connectionManager, 'InboxEnrolled');

    expect(await connectionManager.domainToInbox(newRemoteDomain)).to.equal(
      newInbox.address,
    );
    expect(await connectionManager.inboxToDomain(newInbox.address)).to.equal(
      newRemoteDomain,
    );
    expect(await connectionManager.isInbox(newInbox.address)).to.be.true;
  });

  it('Owner can unenroll a inbox', async () => {
    await expect(
      connectionManager.unenrollInbox(enrolledInbox.address),
    ).to.emit(connectionManager, 'InboxUnenrolled');

    expect(
      await connectionManager.inboxToDomain(enrolledInbox.address),
    ).to.equal(0);
    expect(await connectionManager.domainToInbox(localDomain)).to.equal(
      ethers.constants.AddressZero,
    );
    expect(await connectionManager.isInbox(enrolledInbox.address)).to.be.false;
  });
});
