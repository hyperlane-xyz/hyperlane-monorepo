import { ethers, optics } from 'hardhat';
import { expect } from 'chai';

import { getTestDeploy } from './testChain';
import { Updater, OpticsState, MessageStatus } from '../lib/core';
import { Signer, BytesArray } from '../lib/types';
import { CoreDeploy as Deploy } from 'optics-deploy/dist/src/core/CoreDeploy';
import {
  deployUnenrolledReplica,
  deployUpgradeBeaconController,
  deployUpdaterManager,
} from 'optics-deploy/dist/src/core';

import * as contracts from 'optics-ts-interface/dist/optics-core';

const homeDomainHashTestCases = require('../../../vectors/homeDomainHash.json');
const merkleTestCases = require('../../../vectors/merkle.json');
const proveAndProcessTestCases = require('../../../vectors/proveAndProcess.json');

const localDomain = 2000;
const remoteDomain = 1000;

describe('Replica', async () => {
  const badRecipientFactories = [
    contracts.BadRecipient1__factory,
    contracts.BadRecipient2__factory,
    contracts.BadRecipient3__factory,
    contracts.BadRecipient4__factory,
    contracts.BadRecipient5__factory,
    contracts.BadRecipient6__factory,
  ];

  let deploys: Deploy[] = [];
  let replica: contracts.TestReplica,
    signer: Signer,
    fakeSigner: Signer,
    opticsMessageSender: Signer,
    updater: Updater,
    fakeUpdater: Updater;

  const signAndSubmitUpdate = async (root: string, index: number) => {
    const { signature } = await updater.signUpdate(root, ethers.BigNumber.from(index));
    await replica.update(root, index, signature);
  };

  before(async () => {
    [signer, fakeSigner, opticsMessageSender] = await ethers.getSigners();
    updater = await Updater.fromSigner(signer, remoteDomain);
    fakeUpdater = await Updater.fromSigner(fakeSigner, remoteDomain);

    deploys.push(await getTestDeploy(localDomain, updater.address, []));
    deploys.push(await getTestDeploy(remoteDomain, updater.address, []));
  });

  beforeEach(async () => {
    await deployUpdaterManager(deploys[0]);
    await deployUpgradeBeaconController(deploys[0]);

    await deployUnenrolledReplica(deploys[0], deploys[1]);

    replica = deploys[0].contracts.replicas[remoteDomain]
      .proxy! as contracts.TestReplica;
  });

  it('Cannot be initialized twice', async () => {
    let initData = replica.interface.encodeFunctionData('initialize', [
      deploys[0].chain.domain,
      deploys[0].config.updater,
      ethers.constants.HashZero,
      0,
      deploys[0].config.optimisticSeconds,
    ]);

    await expect(
      signer.sendTransaction({
        to: replica.address,
        data: initData,
      }),
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
    expect(await replica.state()).to.equal(OpticsState.FAILED);

    const root = ethers.utils.formatBytes32String('new root');
    await expect(signAndSubmitUpdate(root, 1)).to.be.revertedWith('failed state');
  });

  it('Calculated domain hash matches Rust-produced domain hash', async () => {
    // Compare Rust output in json file to solidity output (json file matches
    // hash for remote domain of 1000)
    let testDeploy = await getTestDeploy(0, updater.address, []);
    for (let testCase of homeDomainHashTestCases) {
      // set domain, updaterManager and upgradeBeaconController
      testDeploy.chain.domain = testCase.homeDomain;
      testDeploy.contracts.updaterManager = deploys[0].contracts.updaterManager;
      testDeploy.contracts.upgradeBeaconController =
        deploys[0].contracts.upgradeBeaconController;

      // deploy replica
      await deployUnenrolledReplica(testDeploy, testDeploy);
      const tempReplica = testDeploy.contracts.replicas[testCase.homeDomain]
        .proxy! as contracts.TestReplica;

      const { expectedDomainHash } = testCase;
      const homeDomainHash = await tempReplica.testHomeDomainHash();
      expect(homeDomainHash).to.equal(expectedDomainHash);
    }
  });

  it('Accepts update with larger index', async () => {
    const firstRoot = ethers.utils.formatBytes32String('first root');
    const firstIndex = 1;
    await signAndSubmitUpdate(firstRoot, firstIndex);
    expect(await replica.committedIndex()).to.equal(firstIndex);

    const tenthRoot = ethers.utils.formatBytes32String('tenth root');
    const tenthIndex = 10
    await signAndSubmitUpdate(tenthRoot, tenthIndex);
    expect(await replica.committedIndex()).to.equal(tenthIndex);
  });

  it('Rejects updates with same index', async () => {
    const root = ethers.utils.formatBytes32String('root');
    const index = 10
    await signAndSubmitUpdate(root, index);
    await expect(signAndSubmitUpdate(root, index)).to.be.revertedWith('old update');
  });

  it('Rejects updates with zero index', async () => {
    const root = ethers.utils.formatBytes32String('root');
    const index = 0
    await expect(signAndSubmitUpdate(root, index)).to.be.revertedWith('old update');
  });

  it('Rejects update with invalid signature', async () => {
    const root = ethers.utils.formatBytes32String('root');
    const index = 1;
    const { signature: fakeSignature } = await fakeUpdater.signUpdate(
      root,
      ethers.BigNumber.from(index)
    );

    await expect(
      replica.update(root, index, fakeSignature)
    ).to.be.revertedWith('!updater sig');
  });

  it('Proves a valid message', async () => {
    // Use 1st proof of 1st merkle vector test case
    const testCase = merkleTestCases[0];
    let { leaf, index, path } = testCase.proofs[0];

    await replica.setUpdate(testCase.expectedRoot, index);

    // Ensure proper static call return value
    expect(await replica.callStatic.prove(leaf, path as BytesArray, index)).to
      .be.true;

    await replica.prove(leaf, path as BytesArray, index);
    expect(await replica.messages(leaf)).to.equal(MessageStatus.PENDING);
  });

  it('Rejects an already-proven message', async () => {
    const testCase = merkleTestCases[0];
    let { leaf, index, path } = testCase.proofs[0];

    await replica.setUpdate(testCase.expectedRoot, index);

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

    await replica.setUpdate(testCase.expectedRoot, index);

    expect(await replica.callStatic.prove(leaf, path as BytesArray, index)).to
      .be.false;

    await replica.prove(leaf, path as BytesArray, index);
    expect(await replica.messages(leaf)).to.equal(MessageStatus.NONE);
  });

  it('Processes a proved message', async () => {
    const sender = opticsMessageSender;

    const testRecipientFactory = new contracts.TestRecipient__factory(signer);
    const testRecipient = await testRecipientFactory.deploy();

    const nonce = 0;
    const opticsMessage = optics.formatMessage(
      remoteDomain,
      sender.address,
      nonce,
      localDomain,
      testRecipient.address,
      '0x',
    );

    // Set message status to MessageStatus.Pending
    await replica.setMessagePending(opticsMessage);

    // Ensure proper static call return value
    const success = await replica.callStatic.process(opticsMessage);
    expect(success).to.be.true;

    const processTx = replica.process(opticsMessage);
    await expect(processTx)
      .to.emit(replica, 'Process')
      .withArgs(optics.messageHash(opticsMessage), true, '0x');
  });

  it('Fails to process an unproved message', async () => {
    const [sender, recipient] = await ethers.getSigners();
    const nonce = 0;
    const body = ethers.utils.formatBytes32String('message');

    const opticsMessage = optics.formatMessage(
      remoteDomain,
      sender.address,
      nonce,
      localDomain,
      recipient.address,
      body,
    );

    await expect(replica.process(opticsMessage)).to.be.revertedWith('!proven');
  });

  for (let i = 0; i < badRecipientFactories.length; i++) {
    it(`Processes a message from a badly implemented recipient (${
      i + 1
    })`, async () => {
      const sender = opticsMessageSender;
      const factory = new badRecipientFactories[i](signer);
      const badRecipient = await factory.deploy();

      const nonce = 0;
      const opticsMessage = optics.formatMessage(
        remoteDomain,
        sender.address,
        nonce,
        localDomain,
        badRecipient.address,
        '0x',
      );

      // Set message status to MessageStatus.Pending
      await replica.setMessagePending(opticsMessage);
      await replica.process(opticsMessage);
    });
  }

  it('Fails to process message with wrong destination Domain', async () => {
    const [sender, recipient] = await ethers.getSigners();
    const nonce = 0;
    const body = ethers.utils.formatBytes32String('message');

    const opticsMessage = optics.formatMessage(
      remoteDomain,
      sender.address,
      nonce,
      // Wrong destination Domain
      localDomain + 5,
      recipient.address,
      body,
    );

    await expect(replica.process(opticsMessage)).to.be.revertedWith(
      '!destination',
    );
  });

  it('Processes message sent to a non-existent contract address', async () => {
    const nonce = 0;
    const body = ethers.utils.formatBytes32String('message');

    const opticsMessage = optics.formatMessage(
      remoteDomain,
      opticsMessageSender.address,
      nonce,
      localDomain,
      '0x1234567890123456789012345678901234567890', // non-existent contract address
      body,
    );

    // Set message status to MessageStatus.Pending
    await replica.setMessagePending(opticsMessage);
    await expect(replica.process(opticsMessage)).to.not.be.reverted;
  });

  it('Fails to process an undergased transaction', async () => {
    const [sender, recipient] = await ethers.getSigners();
    const nonce = 0;
    const body = ethers.utils.formatBytes32String('message');

    const opticsMessage = optics.formatMessage(
      remoteDomain,
      sender.address,
      nonce,
      localDomain,
      recipient.address,
      body,
    );

    // Set message status to MessageStatus.Pending
    await replica.setMessagePending(opticsMessage);

    // Required gas is >= 510,000 (we provide 500,000)
    await expect(
      replica.process(opticsMessage, { gasLimit: 500000 }),
    ).to.be.revertedWith('!gas');
  });

  it('Returns false when processing message for bad handler function', async () => {
    const sender = opticsMessageSender;
    const [recipient] = await ethers.getSigners();
    const factory = new contracts.BadRecipientHandle__factory(recipient);
    const testRecipient = await factory.deploy();

    const nonce = 0;
    const opticsMessage = optics.formatMessage(
      remoteDomain,
      sender.address,
      nonce,
      localDomain,
      testRecipient.address,
      '0x',
    );

    // Set message status to MessageStatus.Pending
    await replica.setMessagePending(opticsMessage);

    // Ensure bad handler function causes process to return false
    let success = await replica.callStatic.process(opticsMessage);
    expect(success).to.be.false;
  });

  it('Proves and processes a message', async () => {
    const sender = opticsMessageSender;
    const testRecipientFactory = new contracts.TestRecipient__factory(signer);
    const testRecipient = await testRecipientFactory.deploy();

    const nonce = 0;

    // Note that hash of this message specifically matches leaf of 1st
    // proveAndProcess test case
    const opticsMessage = optics.formatMessage(
      remoteDomain,
      sender.address,
      nonce,
      localDomain,
      testRecipient.address,
      '0x',
    );

    // Assert above message and test case have matching leaves
    const { path, index } = proveAndProcessTestCases[0];
    const messageHash = optics.messageHash(opticsMessage);

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
    await replica.setUpdate(proofRoot, index);

    await replica.proveAndProcess(opticsMessage, path as BytesArray, index);

    expect(await replica.messages(messageHash)).to.equal(
      MessageStatus.PROCESSED,
    );
  });

  it('Has proveAndProcess fail if prove fails', async () => {
    const [sender, recipient] = await ethers.getSigners();
    const nonce = 0;

    // Use 1st proof of 1st merkle vector test case
    const testCase = merkleTestCases[0];
    let { index, path } = testCase.proofs[0];

    // Create arbitrary message (contents not important)
    const opticsMessage = optics.formatMessage(
      remoteDomain,
      sender.address,
      nonce,
      localDomain,
      recipient.address,
      '0x',
    );

    await expect(
      replica.proveAndProcess(opticsMessage, path as BytesArray, index),
    ).to.be.revertedWith('!prove');
  });
});
