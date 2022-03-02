import { ethers } from 'hardhat';
import { expect } from 'chai';

import {
  formatMessage,
  messageHash,
  Validator,
  AbacusState,
  MessageStatus,
} from './lib/core';
import { Signer, BytesArray } from './lib/types';
import {
  BadRecipient1__factory,
  BadRecipient2__factory,
  BadRecipient3__factory,
  BadRecipient4__factory,
  BadRecipient5__factory,
  BadRecipient6__factory,
  BadRecipientHandle__factory,
  TestInbox,
  TestInbox__factory,
  ValidatorManager,
  ValidatorManager__factory,
  TestRecipient__factory,
} from '../typechain';

const outboxDomainHashTestCases = require('../../../vectors/outboxDomainHash.json');
const merkleTestCases = require('../../../vectors/merkle.json');
const proveAndProcessTestCases = require('../../../vectors/proveAndProcess.json');

const localDomain = 2000;
const remoteDomain = 1000;
const processGas = 850000;
const reserveGas = 15000;

describe('Inbox', async () => {
  const badRecipientFactories = [
    BadRecipient1__factory,
    BadRecipient2__factory,
    BadRecipient3__factory,
    BadRecipient4__factory,
    BadRecipient5__factory,
    BadRecipient6__factory,
  ];

  let inbox: TestInbox,
    validatorManager: ValidatorManager,
    signer: Signer,
    fakeSigner: Signer,
    abacusMessageSender: Signer,
    validator: Validator,
    fakeValidator: Validator;

  before(async () => {
    [signer, fakeSigner, abacusMessageSender] = await ethers.getSigners();
    validator = await Validator.fromSigner(signer, remoteDomain);
    fakeValidator = await Validator.fromSigner(fakeSigner, remoteDomain);
    const validatorManagerFactory = new ValidatorManager__factory(signer);
    validatorManager = await validatorManagerFactory.deploy();
    await validatorManager.setValidator(remoteDomain, validator.address);
  });

  beforeEach(async () => {
    const inboxFactory = new TestInbox__factory(signer);
    inbox = await inboxFactory.deploy(localDomain, processGas, reserveGas);
    await inbox.initialize(
      remoteDomain,
      validatorManager.address,
      ethers.constants.HashZero,
      0,
    );
  });

  it('Cannot be initialized twice', async () => {
    await expect(
      inbox.initialize(
        remoteDomain,
        validatorManager.address,
        ethers.constants.HashZero,
        0,
      ),
    ).to.be.revertedWith('Initializable: contract is already initialized');
  });

  it('Accepts signed checkpoint from validator', async () => {
    const root = ethers.utils.formatBytes32String('first new root');
    const index = 1;
    const { signature } = await validator.signCheckpoint(root, index);
    await inbox.checkpoint(root, index, signature);
    const [croot, cindex] = await inbox.latestCheckpoint();
    expect(croot).to.equal(root);
    expect(cindex).to.equal(index);
  });

  it('Rejects signed checkpoint from non-validator', async () => {
    const root = ethers.utils.formatBytes32String('first new root');
    const index = 1;
    const { signature } = await fakeValidator.signCheckpoint(root, index);
    await expect(inbox.checkpoint(root, index, signature)).to.be.revertedWith(
      '!validator sig',
    );
  });

  it('Rejects old signed checkpoint from validator', async () => {
    let root = ethers.utils.formatBytes32String('first new root');
    let index = 10;
    let { signature } = await validator.signCheckpoint(root, index);
    await inbox.checkpoint(root, index, signature);
    const [croot, cindex] = await inbox.latestCheckpoint();
    expect(croot).to.equal(root);
    expect(cindex).to.equal(index);

    root = ethers.utils.formatBytes32String('second new root');
    index = 9;
    ({ signature } = await validator.signCheckpoint(root, index));
    await expect(inbox.checkpoint(root, index, signature)).to.be.revertedWith(
      'old checkpoint',
    );
  });

  it('Proves a valid message', async () => {
    // Use 1st proof of 1st merkle vector test case
    const testCase = merkleTestCases[0];
    let { leaf, index, path } = testCase.proofs[0];

    await inbox.setCheckpoint(testCase.expectedRoot, 1);

    // Ensure proper static call return value
    expect(await inbox.callStatic.prove(leaf, path as BytesArray, index)).to.be
      .true;

    await inbox.prove(leaf, path as BytesArray, index);
    expect(await inbox.messages(leaf)).to.equal(MessageStatus.PENDING);
  });

  it('Rejects an already-proven message', async () => {
    const testCase = merkleTestCases[0];
    let { leaf, index, path } = testCase.proofs[0];

    await inbox.setCheckpoint(testCase.expectedRoot, 1);

    // Prove message, which changes status to MessageStatus.Pending
    await inbox.prove(leaf, path as BytesArray, index);
    expect(await inbox.messages(leaf)).to.equal(MessageStatus.PENDING);

    // Try to prove message again
    await expect(
      inbox.prove(leaf, path as BytesArray, index),
    ).to.be.revertedWith('!MessageStatus.None');
  });

  it('Rejects invalid message proof', async () => {
    // Use 1st proof of 1st merkle vector test case
    const testCase = merkleTestCases[0];
    let { leaf, index, path } = testCase.proofs[0];

    // Switch ordering of proof hashes
    // NB: We copy 'path' here to avoid mutating the test cases for
    // other tests.
    const newPath = [...path];
    newPath[0] = path[1];
    newPath[1] = path[0];

    await inbox.setCheckpoint(testCase.expectedRoot, 1);

    expect(await inbox.callStatic.prove(leaf, newPath as BytesArray, index)).to
      .be.false;

    await inbox.prove(leaf, newPath as BytesArray, index);
    expect(await inbox.messages(leaf)).to.equal(MessageStatus.NONE);
  });

  it('Processes a proved message', async () => {
    const sender = abacusMessageSender;

    const testRecipientFactory = new TestRecipient__factory(signer);
    const testRecipient = await testRecipientFactory.deploy();

    const nonce = 0;
    const abacusMessage = formatMessage(
      remoteDomain,
      sender.address,
      nonce,
      localDomain,
      testRecipient.address,
      '0x',
    );

    // Set message status to MessageStatus.Pending
    await inbox.setMessageProven(abacusMessage);

    // Ensure proper static call return value
    const success = await inbox.callStatic.process(abacusMessage);
    expect(success).to.be.true;

    const processTx = inbox.process(abacusMessage);
    await expect(processTx)
      .to.emit(inbox, 'Process')
      .withArgs(messageHash(abacusMessage), true, '0x');
  });

  it('Fails to process an unproved message', async () => {
    const [sender, recipient] = await ethers.getSigners();
    const nonce = 0;
    const body = ethers.utils.formatBytes32String('message');

    const abacusMessage = formatMessage(
      remoteDomain,
      sender.address,
      nonce,
      localDomain,
      recipient.address,
      body,
    );

    await expect(inbox.process(abacusMessage)).to.be.revertedWith('!proven');
  });

  for (let i = 0; i < badRecipientFactories.length; i++) {
    it(`Processes a message from a badly implemented recipient (${
      i + 1
    })`, async () => {
      const sender = abacusMessageSender;
      const factory = new badRecipientFactories[i](signer);
      const badRecipient = await factory.deploy();

      const nonce = 0;
      const abacusMessage = formatMessage(
        remoteDomain,
        sender.address,
        nonce,
        localDomain,
        badRecipient.address,
        '0x',
      );

      // Set message status to MessageStatus.Pending
      await inbox.setMessageProven(abacusMessage);
      await inbox.process(abacusMessage);
    });
  }

  it('Fails to process message with wrong destination Domain', async () => {
    const [sender, recipient] = await ethers.getSigners();
    const nonce = 0;
    const body = ethers.utils.formatBytes32String('message');

    const abacusMessage = formatMessage(
      remoteDomain,
      sender.address,
      nonce,
      // Wrong destination Domain
      localDomain + 5,
      recipient.address,
      body,
    );

    await expect(inbox.process(abacusMessage)).to.be.revertedWith(
      '!destination',
    );
  });

  it('Processes message sent to a non-existent contract address', async () => {
    const nonce = 0;
    const body = ethers.utils.formatBytes32String('message');

    const abacusMessage = formatMessage(
      remoteDomain,
      abacusMessageSender.address,
      nonce,
      localDomain,
      '0x1234567890123456789012345678901234567890', // non-existent contract address
      body,
    );

    // Set message status to MessageStatus.Pending
    await inbox.setMessageProven(abacusMessage);
    await expect(inbox.process(abacusMessage)).to.not.be.reverted;
  });

  it('Fails to process an undergased transaction', async () => {
    const [sender, recipient] = await ethers.getSigners();
    const nonce = 0;
    const body = ethers.utils.formatBytes32String('message');

    const abacusMessage = formatMessage(
      remoteDomain,
      sender.address,
      nonce,
      localDomain,
      recipient.address,
      body,
    );

    // Set message status to MessageStatus.Pending
    await inbox.setMessageProven(abacusMessage);

    // Required gas is >= 510,000 (we provide 500,000)
    await expect(
      inbox.process(abacusMessage, { gasLimit: 500000 }),
    ).to.be.revertedWith('!gas');
  });

  it('Returns false when processing message for bad handler function', async () => {
    const sender = abacusMessageSender;
    const [recipient] = await ethers.getSigners();
    const factory = new BadRecipientHandle__factory(recipient);
    const testRecipient = await factory.deploy();

    const nonce = 0;
    const abacusMessage = formatMessage(
      remoteDomain,
      sender.address,
      nonce,
      localDomain,
      testRecipient.address,
      '0x',
    );

    // Set message status to MessageStatus.Pending
    await inbox.setMessageProven(abacusMessage);

    // Ensure bad handler function causes process to return false
    let success = await inbox.callStatic.process(abacusMessage);
    expect(success).to.be.false;
  });

  it('Proves and processes a message', async () => {
    const sender = abacusMessageSender;
    const testRecipientFactory = new TestRecipient__factory(signer);
    const testRecipient = await testRecipientFactory.deploy();

    const nonce = 0;

    // Note that hash of this message specifically matches leaf of 1st
    // proveAndProcess test case
    const abacusMessage = formatMessage(
      remoteDomain,
      sender.address,
      nonce,
      localDomain,
      testRecipient.address,
      '0x',
    );

    // Assert above message and test case have matching leaves
    const { path, index } = proveAndProcessTestCases[0];
    const hash = messageHash(abacusMessage);

    // Set inbox's current root to match newly computed root that includes
    // the new leaf (normally root will have already been computed and path
    // simply verifies leaf is in tree but because it is cryptographically
    // impossible to find the inputs that create a pre-determined root, we
    // simply recalculate root with the leaf using branchRoot)
    const proofRoot = await inbox.testBranchRoot(
      hash,
      path as BytesArray,
      index,
    );
    await inbox.setCheckpoint(proofRoot, 1);

    await inbox.proveAndProcess(abacusMessage, path as BytesArray, index);

    expect(await inbox.messages(hash)).to.equal(MessageStatus.PROCESSED);
  });

  it('Has proveAndProcess fail if prove fails', async () => {
    const [sender, recipient] = await ethers.getSigners();
    const nonce = 0;

    // Use 1st proof of 1st merkle vector test case
    const testCase = merkleTestCases[0];
    let { leaf, index, path } = testCase.proofs[0];

    // Create arbitrary message (contents not important)
    const abacusMessage = formatMessage(
      remoteDomain,
      sender.address,
      nonce,
      localDomain,
      recipient.address,
      '0x',
    );

    // Ensure root given in proof and actual root don't match so that
    // inbox.prove(...) will fail
    const proofRoot = await inbox.testBranchRoot(
      leaf,
      path as BytesArray,
      index,
    );
    const rootIndex = await inbox.checkpoints(proofRoot);
    expect(rootIndex).to.equal(0);

    await expect(
      inbox.proveAndProcess(abacusMessage, path as BytesArray, index),
    ).to.be.revertedWith('!prove');
  });
});
