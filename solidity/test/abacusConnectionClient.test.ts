import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import {
  AbacusConnectionManager,
  AbacusConnectionManager__factory,
  InterchainGasPaymaster,
  InterchainGasPaymaster__factory,
  Outbox__factory,
  TestInbox__factory,
  TestMultisigValidatorManager__factory,
} from '../types';
import {
  TestAbacusConnectionClient,
  TestAbacusConnectionClient__factory,
} from '../types';

const ONLY_OWNER_REVERT_MSG = 'Ownable: caller is not the owner';

describe('AbacusConnectionClient', async () => {
  let connectionClient: TestAbacusConnectionClient,
    connectionManager: AbacusConnectionManager,
    signer: SignerWithAddress,
    nonOwner: SignerWithAddress;

  before(async () => {
    [signer, nonOwner] = await ethers.getSigners();
  });

  beforeEach(async () => {
    const connectionManagerFactory = new AbacusConnectionManager__factory(
      signer,
    );
    connectionManager = await connectionManagerFactory.deploy();

    const connectionClientFactory = new TestAbacusConnectionClient__factory(
      signer,
    );
    connectionClient = await connectionClientFactory.deploy();
    await connectionClient.initialize(connectionManager.address);
  });

  it('Cannot be initialized twice', async () => {
    await expect(
      connectionClient.initialize(ethers.constants.AddressZero),
    ).to.be.revertedWith('Initializable: contract is already initialized');
  });

  it('owner can set connection manager', async () => {
    const newConnectionManager = signer.address;
    expect(await connectionClient.abacusConnectionManager()).to.not.equal(
      newConnectionManager,
    );
    await expect(
      connectionClient.setAbacusConnectionManager(newConnectionManager),
    ).to.emit(connectionClient, 'AbacusConnectionManagerSet');
    expect(await connectionClient.abacusConnectionManager()).to.equal(
      newConnectionManager,
    );
  });

  it('non-owner cannot set connection manager', async () => {
    await expect(
      connectionClient
        .connect(nonOwner)
        .setAbacusConnectionManager(signer.address),
    ).to.be.revertedWith(ONLY_OWNER_REVERT_MSG);
  });

  it('returns outbox from connection manager', async () => {
    // must be contract
    const outbox = connectionManager.address;
    expect(await connectionClient.outbox()).to.equal(
      ethers.constants.AddressZero,
    );
    await connectionManager.setOutbox(outbox);
    expect(await connectionClient.outbox()).to.equal(outbox);
  });

  it('returns inbox from connection manager', async () => {
    const domain = 1;
    const remoteDomain = 2;
    const validatorManager = await new TestMultisigValidatorManager__factory(
      signer,
    ).deploy(domain, [nonOwner.address], 1);
    const inboxContract = await new TestInbox__factory(signer).deploy(domain);
    await inboxContract.initialize(remoteDomain, validatorManager.address);
    const inbox = inboxContract.address;
    expect(await connectionClient.isInbox(inbox)).to.equal(false);
    await connectionManager.enrollInbox(domain, inbox);
    expect(await connectionClient.isInbox(inbox)).to.equal(true);
  });

  it('returns local domain from outbox', async () => {
    const localDomain = 3;
    const outboxFactory = new Outbox__factory(signer);
    const outbox = await outboxFactory.deploy(localDomain);
    await connectionManager.setOutbox(outbox.address);
    expect(await connectionClient.localDomain()).to.equal(localDomain);
  });

  describe('#setInterchainGasPaymaster', () => {
    let newPaymaster: InterchainGasPaymaster;

    before(async () => {
      const paymasterFactory = new InterchainGasPaymaster__factory(signer);
      newPaymaster = await paymasterFactory.deploy();
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
