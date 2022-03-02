import { abacus, ethers } from 'hardhat';
import { expect } from 'chai';

import * as utils from './utils';
import { Validator, MessageStatus } from '../lib/core';
import { Signer, BytesArray } from '../lib/types';
import { TestRecipient__factory, TestInbox } from '../../typechain';
import { AbacusDeployment } from '../lib/AbacusDeployment';
import { GovernanceDeployment } from '../lib/GovernanceDeployment';

const proveAndProcessTestCases = require('../../../../vectors/proveAndProcess.json');

const domains = [1000, 2000];
const localDomain = domains[0];
const remoteDomain = domains[1];

/*
 * Deploy the full Abacus suite on two chains
 * dispatch messages to Outbox
 * checkpoint on  Outbox
 * Sign and relay checkpoints to Inbox
 * TODO prove and process messages on Inbox
 */
describe('SimpleCrossChainMessage', async () => {
  let abacusDeployment: AbacusDeployment;
  let governanceDeployment: GovernanceDeployment;
  let randomSigner: Signer, validator: Validator;

  before(async () => {
    [randomSigner] = await ethers.getSigners();
    validator = await Validator.fromSigner(randomSigner, localDomain);
    abacusDeployment = await AbacusDeployment.fromDomains(
      domains,
      randomSigner,
    );
    governanceDeployment = await GovernanceDeployment.fromAbacusDeployment(
      abacusDeployment,
      randomSigner,
    );
  });

  it('All Outboxs have correct initial state', async () => {
    const nullRoot = '0x' + '00'.repeat(32);

    const governorOutbox = abacusDeployment.outbox(localDomain);

    let [root, index] = await governorOutbox.latestCheckpoint();
    expect(root).to.equal(nullRoot);
    expect(index).to.equal(0);

    const nonGovernorOutbox = abacusDeployment.outbox(remoteDomain);

    [root, index] = await nonGovernorOutbox.latestCheckpoint();
    expect(root).to.equal(nullRoot);
    expect(index).to.equal(0);
  });

  it('Origin Outbox accepts valid messages', async () => {
    const messages = ['message'].map((message) =>
      utils.formatMessage(message, remoteDomain, randomSigner.address),
    );
    await utils.dispatchMessages(
      abacusDeployment.outbox(localDomain),
      messages,
    );
  });

  it('Destination Inbox accepts a checkpoint', async () => {
    const outbox = abacusDeployment.outbox(localDomain);
    const inbox = abacusDeployment.inbox(remoteDomain, localDomain);
    await utils.checkpoint(outbox, inbox, validator);
  });

  it('Origin Outbox accepts batched messages', async () => {
    const messages = ['message1', 'message2', 'message3'].map((message) =>
      utils.formatMessage(message, remoteDomain, randomSigner.address),
    );
    await utils.dispatchMessages(
      abacusDeployment.outbox(localDomain),
      messages,
    );
  });

  it('Destination Inbox Accepts a second checkpoint', async () => {
    const outbox = abacusDeployment.outbox(localDomain);
    const inbox = abacusDeployment.inbox(remoteDomain, localDomain);
    await utils.checkpoint(outbox, inbox, validator);
  });

  it('Proves and processes a message on Inbox', async () => {
    // get governance routers
    const governorRouter = governanceDeployment.router(localDomain);
    const nonGovernorRouter = governanceDeployment.router(remoteDomain);

    const inbox = abacusDeployment.inbox(remoteDomain, localDomain);
    const testRecipientFactory = new TestRecipient__factory(randomSigner);
    const TestRecipient = await testRecipientFactory.deploy();

    // ensure `processed` has an initial value of false
    expect(await TestRecipient.processed()).to.be.false;

    // create Call message to test recipient that calls `processCall`
    const arg = true;
    const call = await utils.formatCall(TestRecipient, 'processCall', [arg]);
    const callMessage = abacus.governance.formatCalls([call]);

    // Create Abacus message that is sent from the governor domain and governor
    // to the nonGovernorRouter on the nonGovernorDomain
    const nonce = 0;
    const abacusMessage = abacus.formatMessage(
      1000,
      governorRouter.address,
      nonce,
      2000,
      nonGovernorRouter.address,
      callMessage,
    );

    // get merkle proof
    const { path, index } = proveAndProcessTestCases[0];
    const messageHash = abacus.messageHash(abacusMessage);

    // set root
    const proofRoot = await inbox.testBranchRoot(
      messageHash,
      path as BytesArray,
      index,
    );
    await inbox.setCheckpoint(proofRoot, 1);

    // prove and process message
    await inbox.proveAndProcess(abacusMessage, path as BytesArray, index);

    // expect call to have been processed
    expect(await TestRecipient.processed()).to.be.true;
    expect(await inbox.messages(messageHash)).to.equal(MessageStatus.PROCESSED);
  });
});
