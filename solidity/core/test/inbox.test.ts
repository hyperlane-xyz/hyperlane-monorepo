import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { ethers } from 'hardhat';
import { expect } from 'chai';
import { types, utils } from '@abacus-network/utils';
import {
  BadRecipient1__factory,
  BadRecipient3__factory,
  BadRecipient5__factory,
  BadRecipient6__factory,
  BadRecipientHandle__factory,
  TestInbox,
  TestInbox__factory,
  TestRecipient__factory,
  TestValidatorManager,
  TestValidatorManager__factory,
} from '../types';
import { MessageStatus } from '@abacus-network/utils/dist/src/types';

const proveAndProcessTestCases = require('../../../vectors/proveAndProcess.json');
const messageWithProof = require('../../../vectors/messageWithProof.json');

const localDomain = 2000;
const remoteDomain = 1000;

describe('Inbox', async () => {
  const badRecipientFactories = [
    BadRecipient1__factory,
    BadRecipient3__factory,
    BadRecipient5__factory,
    BadRecipient6__factory,
  ];

  let inbox: TestInbox,
    signer: SignerWithAddress,
    abacusMessageSender: SignerWithAddress,
    validatorManager: TestValidatorManager;

  before(async () => {
    [signer, abacusMessageSender] = await ethers.getSigners();
    // Inbox.initialize will ensure the validator manager is a contract.
    // TestValidatorManager doesn't have any special logic, it just submits
    // checkpoints without any signature verification.
    const testValidatorManagerFactory = new TestValidatorManager__factory(
      signer,
    );
    validatorManager = await testValidatorManagerFactory.deploy();
  });

  beforeEach(async () => {
    const inboxFactory = new TestInbox__factory(signer);
    inbox = await inboxFactory.deploy(localDomain);
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

  it('Accepts checkpoint from validator manager', async () => {
    const root = ethers.utils.formatBytes32String('first new root');
    const index = 1;
    await validatorManager.checkpoint(inbox.address, root, index);
    const [croot, cindex] = await inbox.latestCheckpoint();
    expect(croot).to.equal(root);
    expect(cindex).to.equal(index);
  });

  it('Rejects checkpoint from non-validator manager', async () => {
    const root = ethers.utils.formatBytes32String('first new root');
    const index = 1;
    await expect(inbox.checkpoint(root, index)).to.be.revertedWith(
      '!validatorManager',
    );
  });

  it('Rejects old checkpoint from validator manager', async () => {
    let root = ethers.utils.formatBytes32String('first new root');
    let index = 10;
    await validatorManager.checkpoint(inbox.address, root, index);
    const [croot, cindex] = await inbox.latestCheckpoint();
    expect(croot).to.equal(root);
    expect(cindex).to.equal(index);

    root = ethers.utils.formatBytes32String('second new root');
    index = 9;
    await expect(
      validatorManager.checkpoint(inbox.address, root, index),
    ).to.be.revertedWith('old checkpoint');
  });

  it('Processes a valid message', async () => {
    let { index, proof, root, message } = messageWithProof;
    await inbox.setCheckpoint(root, 1);

    // We assume correctness of processing via a successful call to a non-existing account
    await expect(inbox.process(message, proof, index, '0x')).to.be.revertedWith(
      'function call to a non-contract account',
    );
  });

  it('Rejects an already-processed message', async () => {
    let { leaf, index, proof, root, message } = messageWithProof;

    await inbox.setCheckpoint(root, 1);
    // Set message status as MessageStatus.Processed
    await inbox.setMessageStatus(leaf, MessageStatus.PROCESSED);

    // Try to process message again
    await expect(inbox.process(message, proof, index, '0x')).to.be.revertedWith(
      '!MessageStatus.None',
    );
  });

  it('Rejects invalid message proof', async () => {
    let { leaf, index, proof, root, message } = messageWithProof;

    // Switch ordering of proof hashes
    // NB: We copy 'path' here to avoid mutating the test cases for
    // other tests.
    const newProof = [...proof];
    newProof[0] = proof[1];
    newProof[1] = proof[0];

    await inbox.setCheckpoint(root, 1);

    expect(
      inbox.process(message, newProof as types.BytesArray, index, '0x'),
    ).to.be.revertedWith('!checkpointed root');
    expect(await inbox.messages(leaf)).to.equal(types.MessageStatus.NONE);
  });

  for (let i = 0; i < badRecipientFactories.length; i++) {
    it(`Fails to process a message for a badly implemented recipient (${
      i + 1
    })`, async () => {
      const sender = abacusMessageSender;
      const factory = new badRecipientFactories[i](signer);
      const badRecipient = await factory.deploy();

      const nonce = 0;
      const abacusMessage = utils.formatMessage(
        remoteDomain,
        sender.address,
        nonce,
        localDomain,
        badRecipient.address,
        '0x',
      );

      await expect(inbox.testProcess(abacusMessage)).to.be.reverted;
    });
  }

  it('Fails to process message with wrong destination Domain', async () => {
    const [sender, recipient] = await ethers.getSigners();
    const nonce = 0;
    const body = ethers.utils.formatBytes32String('message');

    const abacusMessage = utils.formatMessage(
      remoteDomain,
      sender.address,
      nonce,
      // Wrong destination Domain
      localDomain + 5,
      recipient.address,
      body,
    );

    await expect(inbox.testProcess(abacusMessage)).to.be.revertedWith(
      '!destination',
    );
  });

  it('Fails to process message sent to a non-existent contract address', async () => {
    const nonce = 0;
    const body = ethers.utils.formatBytes32String('message');

    const abacusMessage = utils.formatMessage(
      remoteDomain,
      abacusMessageSender.address,
      nonce,
      localDomain,
      '0x1234567890123456789012345678901234567890', // non-existent contract address
      body,
    );

    await expect(inbox.testProcess(abacusMessage)).to.be.reverted;
  });

  it('Fails to process a message for bad handler function', async () => {
    const sender = abacusMessageSender;
    const [recipient] = await ethers.getSigners();
    const factory = new BadRecipientHandle__factory(recipient);
    const testRecipient = await factory.deploy();

    const nonce = 0;
    const abacusMessage = utils.formatMessage(
      remoteDomain,
      sender.address,
      nonce,
      localDomain,
      testRecipient.address,
      '0x',
    );

    // Ensure bad handler function causes process to fail
    await expect(inbox.testProcess(abacusMessage)).to.be.reverted;
  });

  it('Processes a message directly', async () => {
    const sender = abacusMessageSender;
    const [recipient] = await ethers.getSigners();
    const factory = new TestRecipient__factory(recipient);
    const testRecipient = await factory.deploy();

    const nonce = 0;
    const abacusMessage = utils.formatMessage(
      remoteDomain,
      sender.address,
      nonce,
      localDomain,
      testRecipient.address,
      '0x',
    );

    await inbox.testProcess(abacusMessage);

    const hash = utils.messageHash(abacusMessage);
    expect(await inbox.messages(hash)).to.eql(MessageStatus.PROCESSED);
  });

  it('Proves and processes a message', async () => {
    const sender = abacusMessageSender;
    const testRecipientFactory = new TestRecipient__factory(signer);
    const testRecipient = await testRecipientFactory.deploy();

    const nonce = 0;

    // Note that hash of this message specifically matches leaf of 1st
    // proveAndProcess test case
    const abacusMessage = utils.formatMessage(
      remoteDomain,
      sender.address,
      nonce,
      localDomain,
      testRecipient.address,
      '0x',
    );

    // Assert above message and test case have matching leaves
    const { path, index } = proveAndProcessTestCases[0];
    const hash = utils.messageHash(abacusMessage);

    // Set inbox's current root to match newly computed root that includes
    // the new leaf (normally root will have already been computed and path
    // simply verifies leaf is in tree but because it is cryptographically
    // impossible to find the inputs that create a pre-determined root, we
    // simply recalculate root with the leaf using branchRoot)
    const proofRoot = await inbox.testBranchRoot(
      hash,
      path as types.BytesArray,
      index,
    );
    await inbox.setCheckpoint(proofRoot, 1);

    await inbox.process(abacusMessage, path as types.BytesArray, index, '0x');

    expect(await inbox.messages(hash)).to.equal(types.MessageStatus.PROCESSED);
  });
});
