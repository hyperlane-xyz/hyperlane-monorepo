import { ethers } from 'hardhat';
import { expect } from 'chai';
import { ContractTransaction } from 'ethers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';

import {
  InterchainGasPaymaster__factory,
  TestOutbox__factory,
  TestInbox__factory,
  XAppConnectionManager,
  XAppConnectionManager__factory,
  TestInbox,
} from '../types';

const ONLY_OWNER_REVERT_MSG = 'Ownable: caller is not the owner';
const localDomain = 1000;
const remoteDomain = 2000;

describe.only('XAppConnectionManager', async () => {
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
    enrolledInbox = await inboxFactory.deploy(localDomain);
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

  // Used for testing `setOutbox` and `setOutboxAndInterchainGasPaymaster` to avoid
  // code duplication
  const setOutboxTests = (
    setter: (
      outbox: string,
      signer?: SignerWithAddress,
    ) => Promise<ContractTransaction>,
  ) => {
    it('Allows owner to set the outbox', async () => {
      const outboxFactory = new TestOutbox__factory(signer);
      const newOutbox = await outboxFactory.deploy(localDomain);

      await setter(newOutbox.address);
      expect(await connectionManager.outbox()).to.equal(newOutbox.address);
    });

    it('Emits the NewOutbox event', async () => {
      const outboxFactory = new TestOutbox__factory(signer);
      const newOutbox = await outboxFactory.deploy(localDomain);

      await expect(setter(newOutbox.address))
        .to.emit(connectionManager, 'NewOutbox')
        .withArgs(newOutbox.address);
    });

    it('Reverts a call from non-owner', async () => {
      const [nonOutbox, nonOwner] = await ethers.getSigners();
      await expect(setter(nonOutbox.address, nonOwner)).to.be.revertedWith(
        ONLY_OWNER_REVERT_MSG,
      );
    });
  };

  // Used for testing `setInterchainGasPaymaster` and `setOutboxAndInterchainGasPaymaster`
  // to avoid code duplication
  const setInterchainGasPaymasterTests = (
    setter: (
      interchainGasPaymaster: string,
      signer?: SignerWithAddress,
    ) => Promise<ContractTransaction>,
  ) => {
    it('Allows owner to set the interchainGasPaymaster', async () => {
      const paymasterFactory = new InterchainGasPaymaster__factory(signer);
      const newPaymaster = await paymasterFactory.deploy();

      await setter(newPaymaster.address);
      expect(await connectionManager.interchainGasPaymaster()).to.equal(
        newPaymaster.address,
      );
    });

    it('Emits the NewInterchainGasPaymaster event', async () => {
      const paymasterFactory = new InterchainGasPaymaster__factory(signer);
      const newPaymaster = await paymasterFactory.deploy();

      await expect(setter(newPaymaster.address))
        .to.emit(connectionManager, 'NewInterchainGasPaymaster')
        .withArgs(newPaymaster.address);
    });

    it('Reverts a call from non-owner', async () => {
      const [nonInterchainGasPaymaster, nonOwner] = await ethers.getSigners();
      await expect(
        setter(nonInterchainGasPaymaster.address, nonOwner),
      ).to.be.revertedWith(ONLY_OWNER_REVERT_MSG);
    });
  };

  describe('#setOutboxAndInterchainGasPaymaster', () => {
    const dummyAddress = '0xdEADBEeF00000000000000000000000000000000';

    // Test the outbox setting works
    setOutboxTests((outbox: string, signer?: SignerWithAddress) => {
      const connManager = signer
        ? connectionManager.connect(signer)
        : connectionManager;
      return connManager.setOutboxAndInterchainGasPaymaster(
        outbox,
        dummyAddress,
      );
    });

    // And test the interchain gas paymaster setting works
    setInterchainGasPaymasterTests(
      (interchainGasPaymaster: string, signer?: SignerWithAddress) => {
        const connManager = signer
          ? connectionManager.connect(signer)
          : connectionManager;
        return connManager.setOutboxAndInterchainGasPaymaster(
          dummyAddress,
          interchainGasPaymaster,
        );
      },
    );
  });

  describe('#setOutbox', () => {
    setOutboxTests((outbox: string, signer?: SignerWithAddress) => {
      const connManager = signer
        ? connectionManager.connect(signer)
        : connectionManager;
      return connManager.setOutbox(outbox);
    });
  });

  describe('#setInterchainGasPaymaster', () => {
    setInterchainGasPaymasterTests(
      (interchainGasPaymaster: string, signer?: SignerWithAddress) => {
        const connManager = signer
          ? connectionManager.connect(signer)
          : connectionManager;
        return connManager.setInterchainGasPaymaster(interchainGasPaymaster);
      },
    );
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
