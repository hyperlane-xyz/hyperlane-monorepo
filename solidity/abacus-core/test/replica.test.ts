import { ethers, abacus } from 'hardhat';
import { expect } from 'chai';

import { Updater, AbacusState, MessageStatus } from './lib/core';
import { Signer, BytesArray } from './lib/types';
import {
  BadRecipient1__factory,
  BadRecipient2__factory,
  BadRecipient3__factory,
  BadRecipient4__factory,
  BadRecipient5__factory,
  BadRecipient6__factory,
  BadRecipientHandle__factory,
  TestReplica,
  TestReplica__factory,
  TestRecipient__factory,
} from '../typechain';

const homeDomainHashTestCases = require('../../../vectors/homeDomainHash.json');
const merkleTestCases = require('../../../vectors/merkle.json');
const proveAndProcessTestCases = require('../../../vectors/proveAndProcess.json');

const localDomain = 2000;
const remoteDomain = 1000;
const processGas = 850000;
const reserveGas = 15000;
const optimisticSeconds = 3;

describe('Replica', async () => {
  const badRecipientFactories = [
    BadRecipient1__factory,
    BadRecipient2__factory,
    BadRecipient3__factory,
    BadRecipient4__factory,
    BadRecipient5__factory,
    BadRecipient6__factory,
  ];

  let replica: TestReplica,
    signer: Signer,
    fakeSigner: Signer,
    abacusMessageSender: Signer,
    updater: Updater,
    fakeUpdater: Updater;

  const submitValidUpdate = async (newRoot: string) => {
    const oldRoot = await replica.committedRoot();

    const { signature } = await updater.signUpdate(oldRoot, newRoot);
    await replica.update(oldRoot, newRoot, signature);
  };

  before(async () => {
    [signer, fakeSigner, abacusMessageSender] = await ethers.getSigners();
    updater = await Updater.fromSigner(signer, remoteDomain);
    fakeUpdater = await Updater.fromSigner(fakeSigner, remoteDomain);
  });

  beforeEach(async () => {
    const replicaFactory = new TestReplica__factory(signer);
    replica = await replicaFactory.deploy(localDomain, processGas, reserveGas);
    await replica.initialize(
      remoteDomain,
      updater.address,
      ethers.constants.HashZero,
      optimisticSeconds,
    );
  });

  it('Cannot be initialized twice', async () => {
    await expect(
      replica.initialize(
        remoteDomain,
        updater.address,
        ethers.constants.HashZero,
        optimisticSeconds,
      ),
    ).to.be.revertedWith('Initializable: contract is already initialized');
  });

  it('Owner can transfer ownership', async () => {
    const oldOwner = await replica.owner();
    const newOwner = fakeUpdater.address;
    expect(oldOwner).to.not.be.equal(newOwner);
    await replica.transferOwnership(newOwner);
    expect(await replica.owner()).to.be.equal(newOwner);
  });

  it('Nonowner cannot transfer ownership', async () => {
    const newOwner = fakeUpdater.address;
    await expect(
      replica.connect(fakeSigner).transferOwnership(newOwner),
    ).to.be.revertedWith('!owner');
  });

  it('Owner can rotate updater', async () => {
    const newUpdater = fakeUpdater.address;
    await replica.setUpdater(newUpdater);
    expect(await replica.updater()).to.equal(newUpdater);
  });

  it('Nonowner cannot rotate updater', async () => {
    const newUpdater = fakeUpdater.address;
    await expect(
      replica.connect(fakeSigner).setUpdater(newUpdater),
    ).to.be.revertedWith('!owner');
  });

  it('Halts on fail', async () => {
    await replica.setFailed();
    expect(await replica.state()).to.equal(AbacusState.FAILED);

    const newRoot = ethers.utils.formatBytes32String('new root');
    await expect(submitValidUpdate(newRoot)).to.be.revertedWith('failed state');
  });

  it('Calculated domain hash matches Rust-produced domain hash', async () => {
    // Compare Rust output in json file to solidity output (json file matches
    // hash for remote domain of 1000)
    for (let testCase of homeDomainHashTestCases) {
      // deploy replica
      const replicaFactory = new TestReplica__factory(signer);
      const tempReplica = await replicaFactory.deploy(
        testCase.homeDomain,
        processGas,
        reserveGas,
      );
      await tempReplica.initialize(
        testCase.homeDomain,
        updater.address,
        ethers.constants.HashZero,
        optimisticSeconds,
      );

      const { expectedDomainHash } = testCase;
      const homeDomainHash = await tempReplica.homeDomainHash();
      expect(homeDomainHash).to.equal(expectedDomainHash);
    }
  });

  it('Enqueues pending updates', async () => {
    const firstNewRoot = ethers.utils.formatBytes32String('first new root');
    await submitValidUpdate(firstNewRoot);
    expect(await replica.committedRoot()).to.equal(firstNewRoot);

    const secondNewRoot = ethers.utils.formatBytes32String('second next root');
    await submitValidUpdate(secondNewRoot);
    expect(await replica.committedRoot()).to.equal(secondNewRoot);
  });

  it('Rejects update with invalid signature', async () => {
    const firstNewRoot = ethers.utils.formatBytes32String('first new root');
    await submitValidUpdate(firstNewRoot);

    const secondNewRoot = ethers.utils.formatBytes32String('second new root');
    const { signature: fakeSignature } = await fakeUpdater.signUpdate(
      firstNewRoot,
      secondNewRoot,
    );

    await expect(
      replica.update(firstNewRoot, secondNewRoot, fakeSignature),
    ).to.be.revertedWith('!updater sig');
  });

  it('Rejects initial update not building off initial root', async () => {
    const fakeInitialRoot = ethers.utils.formatBytes32String('fake root');
    const newRoot = ethers.utils.formatBytes32String('new root');
    const { signature } = await updater.signUpdate(fakeInitialRoot, newRoot);

    await expect(
      replica.update(fakeInitialRoot, newRoot, signature),
    ).to.be.revertedWith('not current update');
  });

  it('Rejects updates not building off latest enqueued root', async () => {
    const firstNewRoot = ethers.utils.formatBytes32String('first new root');
    await submitValidUpdate(firstNewRoot);

    const fakeLatestRoot = ethers.utils.formatBytes32String('fake root');
    const secondNewRoot = ethers.utils.formatBytes32String('second new root');
    const { signature } = await updater.signUpdate(
      fakeLatestRoot,
      secondNewRoot,
    );

    await expect(
      replica.update(fakeLatestRoot, secondNewRoot, signature),
    ).to.be.revertedWith('not current update');
  });

  it('Accepts a double update proof', async () => {
    const firstRoot = await replica.committedRoot();
    const secondRoot = ethers.utils.formatBytes32String('second root');
    const thirdRoot = ethers.utils.formatBytes32String('third root');

    const { signature } = await updater.signUpdate(firstRoot, secondRoot);
    const { signature: signature2 } = await updater.signUpdate(
      firstRoot,
      thirdRoot,
    );

    await expect(
      replica.doubleUpdate(
        firstRoot,
        [secondRoot, thirdRoot],
        signature,
        signature2,
      ),
    ).to.emit(replica, 'DoubleUpdate');

    expect(await replica.state()).to.equal(AbacusState.FAILED);
  });

  it('Proves a valid message', async () => {
    // Use 1st proof of 1st merkle vector test case
    const testCase = merkleTestCases[0];
    let { leaf, index, path } = testCase.proofs[0];

    await replica.setCommittedRoot(testCase.expectedRoot);

    // Ensure proper static call return value
    expect(await replica.callStatic.prove(leaf, path as BytesArray, index)).to
      .be.true;

    await replica.prove(leaf, path as BytesArray, index);
    expect(await replica.messages(leaf)).to.equal(MessageStatus.PENDING);
  });

  it('Rejects an already-proven message', async () => {
    const testCase = merkleTestCases[0];
    let { leaf, index, path } = testCase.proofs[0];

    await replica.setCommittedRoot(testCase.expectedRoot);

    // Prove message, which changes status to MessageStatus.Pending
    await replica.prove(leaf, path as BytesArray, index);
    expect(await replica.messages(leaf)).to.equal(MessageStatus.PENDING);

    // Try to prove message again
    await expect(
      replica.prove(leaf, path as BytesArray, index),
    ).to.be.revertedWith('!MessageStatus.None');
  });

  it('Rejects invalid message proof', async () => {
    // Use 1st proof of 1st merkle vector test case
    const testCase = merkleTestCases[0];
    let { leaf, index, path } = testCase.proofs[0];

    // Switch ordering of proof hashes
    const firstHash = path[0];
    path[0] = path[1];
    path[1] = firstHash;

    await replica.setCommittedRoot(testCase.expectedRoot);

    expect(await replica.callStatic.prove(leaf, path as BytesArray, index)).to
      .be.false;

    await replica.prove(leaf, path as BytesArray, index);
    expect(await replica.messages(leaf)).to.equal(MessageStatus.NONE);
  });

  it('Processes a proved message', async () => {
    const sender = abacusMessageSender;

    const testRecipientFactory = new TestRecipient__factory(signer);
    const testRecipient = await testRecipientFactory.deploy();

    const nonce = 0;
    const abacusMessage = abacus.formatMessage(
      remoteDomain,
      sender.address,
      nonce,
      localDomain,
      testRecipient.address,
      '0x',
    );

    // Set message status to MessageStatus.Pending
    await replica.setMessageProven(abacusMessage);

    // Ensure proper static call return value
    const success = await replica.callStatic.process(abacusMessage);
    expect(success).to.be.true;

    const processTx = replica.process(abacusMessage);
    await expect(processTx)
      .to.emit(replica, 'Process')
      .withArgs(abacus.messageHash(abacusMessage), true, '0x');
  });

  it('Fails to process an unproved message', async () => {
    const [sender, recipient] = await ethers.getSigners();
    const nonce = 0;
    const body = ethers.utils.formatBytes32String('message');

    const abacusMessage = abacus.formatMessage(
      remoteDomain,
      sender.address,
      nonce,
      localDomain,
      recipient.address,
      body,
    );

    await expect(replica.process(abacusMessage)).to.be.revertedWith('!proven');
  });

  for (let i = 0; i < badRecipientFactories.length; i++) {
    it(`Processes a message from a badly implemented recipient (${
      i + 1
    })`, async () => {
      const sender = abacusMessageSender;
      const factory = new badRecipientFactories[i](signer);
      const badRecipient = await factory.deploy();

      const nonce = 0;
      const abacusMessage = abacus.formatMessage(
        remoteDomain,
        sender.address,
        nonce,
        localDomain,
        badRecipient.address,
        '0x',
      );

      // Set message status to MessageStatus.Pending
      await replica.setMessageProven(abacusMessage);
      await replica.process(abacusMessage);
    });
  }

  it('Fails to process message with wrong destination Domain', async () => {
    const [sender, recipient] = await ethers.getSigners();
    const nonce = 0;
    const body = ethers.utils.formatBytes32String('message');

    const abacusMessage = abacus.formatMessage(
      remoteDomain,
      sender.address,
      nonce,
      // Wrong destination Domain
      localDomain + 5,
      recipient.address,
      body,
    );

    await expect(replica.process(abacusMessage)).to.be.revertedWith(
      '!destination',
    );
  });

  it('Processes message sent to a non-existent contract address', async () => {
    const nonce = 0;
    const body = ethers.utils.formatBytes32String('message');

    const abacusMessage = abacus.formatMessage(
      remoteDomain,
      abacusMessageSender.address,
      nonce,
      localDomain,
      '0x1234567890123456789012345678901234567890', // non-existent contract address
      body,
    );

    // Set message status to MessageStatus.Pending
    await replica.setMessageProven(abacusMessage);
    await expect(replica.process(abacusMessage)).to.not.be.reverted;
  });

  it('Fails to process an undergased transaction', async () => {
    const [sender, recipient] = await ethers.getSigners();
    const nonce = 0;
    const body = ethers.utils.formatBytes32String('message');

    const abacusMessage = abacus.formatMessage(
      remoteDomain,
      sender.address,
      nonce,
      localDomain,
      recipient.address,
      body,
    );

    // Set message status to MessageStatus.Pending
    await replica.setMessageProven(abacusMessage);

    // Required gas is >= 510,000 (we provide 500,000)
    await expect(
      replica.process(abacusMessage, { gasLimit: 500000 }),
    ).to.be.revertedWith('!gas');
  });

  it('Returns false when processing message for bad handler function', async () => {
    const sender = abacusMessageSender;
    const [recipient] = await ethers.getSigners();
    const factory = new BadRecipientHandle__factory(recipient);
    const testRecipient = await factory.deploy();

    const nonce = 0;
    const abacusMessage = abacus.formatMessage(
      remoteDomain,
      sender.address,
      nonce,
      localDomain,
      testRecipient.address,
      '0x',
    );

    // Set message status to MessageStatus.Pending
    await replica.setMessageProven(abacusMessage);

    // Ensure bad handler function causes process to return false
    let success = await replica.callStatic.process(abacusMessage);
    expect(success).to.be.false;
  });

  it('Proves and processes a message', async () => {
    const sender = abacusMessageSender;
    const testRecipientFactory = new TestRecipient__factory(signer);
    const testRecipient = await testRecipientFactory.deploy();

    const nonce = 0;

    // Note that hash of this message specifically matches leaf of 1st
    // proveAndProcess test case
    const abacusMessage = abacus.formatMessage(
      remoteDomain,
      sender.address,
      nonce,
      localDomain,
      testRecipient.address,
      '0x',
    );

    // Assert above message and test case have matching leaves
    const { path, index } = proveAndProcessTestCases[0];
    const messageHash = abacus.messageHash(abacusMessage);

    // Set replica's current root to match newly computed root that includes
    // the new leaf (normally root will have already been computed and path
    // simply verifies leaf is in tree but because it is cryptographically
    // impossible to find the inputs that create a pre-determined root, we
    // simply recalculate root with the leaf using branchRoot)
    const proofRoot = await replica.testBranchRoot(
      messageHash,
      path as BytesArray,
      index,
    );
    await replica.setCommittedRoot(proofRoot);

    await replica.proveAndProcess(abacusMessage, path as BytesArray, index);

    expect(await replica.messages(messageHash)).to.equal(
      MessageStatus.PROCESSED,
    );
  });

  it('Has proveAndProcess fail if prove fails', async () => {
    const [sender, recipient] = await ethers.getSigners();
    const nonce = 0;

    // Use 1st proof of 1st merkle vector test case
    const testCase = merkleTestCases[0];
    let { leaf, index, path } = testCase.proofs[0];

    // Create arbitrary message (contents not important)
    const abacusMessage = abacus.formatMessage(
      remoteDomain,
      sender.address,
      nonce,
      localDomain,
      recipient.address,
      '0x',
    );

    // Ensure root given in proof and actual root don't match so that
    // replica.prove(...) will fail
    const actualRoot = await replica.committedRoot();
    const proofRoot = await replica.testBranchRoot(
      leaf,
      path as BytesArray,
      index,
    );
    expect(proofRoot).to.not.equal(actualRoot);

    await expect(
      replica.proveAndProcess(abacusMessage, path as BytesArray, index),
    ).to.be.revertedWith('!prove');
  });
});
