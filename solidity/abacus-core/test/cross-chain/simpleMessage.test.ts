import { abacus, ethers } from 'hardhat';
import { expect } from 'chai';

import * as utils from './utils';
import { Updater, MessageStatus } from '../lib/core';
import { Signer, BytesArray } from '../lib/types';
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
  let randomSigner: Signer, updater: Updater;

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

    const governorHome = abacusDeployment.home(localDomain);

    let [root, index] = await governorHome.latestCheckpoint();
    expect(root).to.equal(nullRoot);
    expect(index).to.equal(0);

    const nonGovernorHome = abacusDeployment.home(remoteDomain);

    [root, index] = await nonGovernorHome.latestCheckpoint();
    expect(root).to.equal(nullRoot);
    expect(index).to.equal(0);
  });

  it('Origin Home accepts valid messages', async () => {
    const messages = ['message'].map((message) =>
      utils.formatMessage(message, remoteDomain, randomSigner.address),
    );
    const update = await utils.dispatchMessages(
      abacusDeployment.home(localDomain),
      messages,
    );
  });

  it('Destination Replica accepts a checkpoint', async () => {
    const home = abacusDeployment.home(localDomain);
    const replica = abacusDeployment.replica(remoteDomain, localDomain);
    await utils.checkpoint(home, replica, updater);
  });

  it('Origin Home accepts batched messages', async () => {
    const messages = ['message1', 'message2', 'message3'].map((message) =>
      utils.formatMessage(message, remoteDomain, randomSigner.address),
    );
    const update = await utils.dispatchMessages(
      abacusDeployment.home(localDomain),
      messages,
    );
  });

  it('Destination Replica Accepts a second checkpoint', async () => {
    const home = abacusDeployment.home(localDomain);
    const replica = abacusDeployment.replica(remoteDomain, localDomain);
    await utils.checkpoint(home, replica, updater);
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
    await replica.setCheckpoint(proofRoot, 1);

    // prove and process message
    await replica.proveAndProcess(abacusMessage, path as BytesArray, index);

    // expect call to have been processed
    expect(await TestRecipient.processed()).to.be.true;
    expect(await replica.messages(messageHash)).to.equal(
      MessageStatus.PROCESSED,
    );
  });
});
