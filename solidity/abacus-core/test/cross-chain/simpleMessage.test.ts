import { abacus, ethers } from 'hardhat';
import { expect } from 'chai';

import * as utils from './utils';
import { Updater, MessageStatus } from '../lib/core';
import { Update, Signer, BytesArray } from '../lib/types';
import { TestRecipient__factory, TestReplica } from '../../typechain';
import { AbacusDeployment } from '../lib/AbacusDeployment';
import { GovernanceDeployment } from '../lib/GovernanceDeployment';

const proveAndProcessTestCases = require('../../../../vectors/proveAndProcess.json');

const domains = [1000, 2000];
const localDomain = domains[0];
const remoteDomain = domains[1];

/*
 * Deploy the full Abacus suite on two chains
 * dispatch messages to Home
 * sign and submit updates to Home
 * relay updates to Replica
 * confirm updates on Replica
 * TODO prove and process messages on Replica
 */
describe('SimpleCrossChainMessage', async () => {
  let abacusDeployment: AbacusDeployment;
  let governanceDeployment: GovernanceDeployment;
  let randomSigner: Signer, updater: Updater, latestUpdate: Update;

  before(async () => {
    [randomSigner] = await ethers.getSigners();
    updater = await Updater.fromSigner(randomSigner, localDomain);
    abacusDeployment = await abacus.deployment.fromDomains(
      domains,
      randomSigner,
    );
    governanceDeployment = await GovernanceDeployment.fromAbacusDeployment(
      abacusDeployment,
      randomSigner,
    );
  });

  it('All Homes have correct initial state', async () => {
    const nullRoot = '0x' + '00'.repeat(32);

    // governorHome has 0 updates
    const governorHome = abacusDeployment.home(localDomain);

    let length = await governorHome.queueLength();
    expect(length).to.equal(0);

    let [suggestedCommitted, suggestedNew] = await governorHome.suggestUpdate();
    expect(suggestedCommitted).to.equal(nullRoot);
    expect(suggestedNew).to.equal(nullRoot);

    // nonGovernorHome has 2 updates
    const nonGovernorHome = abacusDeployment.home(remoteDomain);

    length = await nonGovernorHome.queueLength();
    expect(length).to.equal(2);

    [suggestedCommitted, suggestedNew] = await nonGovernorHome.suggestUpdate();
    expect(suggestedCommitted).to.equal(nullRoot);
    expect(suggestedNew).to.not.equal(nullRoot);
  });

  it('Origin Home Accepts one valid update', async () => {
    const messages = ['message'].map((message) =>
      utils.formatMessage(message, remoteDomain, randomSigner.address),
    );
    const update = await utils.dispatchMessagesAndUpdateHome(
      abacusDeployment.home(localDomain),
      messages,
      updater,
    );

    latestUpdate = update;
  });

  it('Destination Replica Accepts the first update', async () => {
    await utils.updateReplica(
      latestUpdate,
      abacusDeployment.replica(remoteDomain, localDomain),
    );
  });

  it('Origin Home Accepts an update with several batched messages', async () => {
    const messages = ['message1', 'message2', 'message3'].map((message) =>
      utils.formatMessage(message, remoteDomain, randomSigner.address),
    );
    const update = await utils.dispatchMessagesAndUpdateHome(
      abacusDeployment.home(localDomain),
      messages,
      updater,
    );
    latestUpdate = update;
  });

  it('Destination Replica Accepts the second update', async () => {
    await utils.updateReplica(
      latestUpdate,
      abacusDeployment.replica(remoteDomain, localDomain),
    );
  });

  it('Destination Replica shows latest update as the committed root', async () => {
    const replica = abacusDeployment.replica(remoteDomain, localDomain);
    const { newRoot } = latestUpdate;
    expect(await replica.committedRoot()).to.equal(newRoot);
  });

  it('Proves and processes a message on Replica', async () => {
    // get governance routers
    const governorRouter = governanceDeployment.router(localDomain);
    const nonGovernorRouter = governanceDeployment.router(remoteDomain);

    const replica = abacusDeployment.replica(remoteDomain, localDomain);
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
    const proofRoot = await replica.testBranchRoot(
      messageHash,
      path as BytesArray,
      index,
    );
    await replica.setCommittedRoot(proofRoot);

    // prove and process message
    await replica.proveAndProcess(abacusMessage, path as BytesArray, index);

    // expect call to have been processed
    expect(await TestRecipient.processed()).to.be.true;
    expect(await replica.messages(messageHash)).to.equal(
      MessageStatus.PROCESSED,
    );
  });
});
