import { ethers, abacus } from 'hardhat';
import { expect } from 'chai';

import { formatCall, formatAbacusMessage } from './utils';
import { increaseTimestampBy, UpgradeTestHelpers } from '../utils';
import { Validator } from '../lib/core';
import { Address, Signer } from '../lib/types';
import { AbacusDeployment } from '../lib/AbacusDeployment';
import { GovernanceDeployment } from '../lib/GovernanceDeployment';
import {
  MysteryMathV2__factory,
  TestInbox,
  TestInbox__factory,
  TestRecipient__factory,
  TestGovernanceRouter,
  Inbox,
  Outbox,
} from '../../typechain';

const helpers = require('../../../../vectors/proof.json');

const governorDomain = 1000;
const nonGovernorDomain = 2000;
const thirdDomain = 3000;
const domains = [governorDomain, nonGovernorDomain, thirdDomain];
const processGas = 850000;
const reserveGas = 15000;
const nullRoot = '0x' + '00'.repeat(32);

/*
 * Deploy the full Abacus suite on two chains
 */
describe('GovernanceRouter', async () => {
  let abacusDeployment: AbacusDeployment;
  let governanceDeployment: GovernanceDeployment;
  let signer: Signer,
    secondSigner: Signer,
    thirdRouter: Signer,
    firstGovernor: Address,
    secondGovernor: Address,
    governorRouter: TestGovernanceRouter,
    nonGovernorRouter: TestGovernanceRouter,
    governorOutbox: Outbox,
    governorInboxOnNonGovernorChain: TestInbox,
    nonGovernorInboxOnGovernorChain: TestInbox,
    validator: Validator;

  async function expectGovernor(
    governanceRouter: TestGovernanceRouter,
    expectedGovernorDomain: number,
    expectedGovernor: Address,
  ) {
    expect(await governanceRouter.governorDomain()).to.equal(
      expectedGovernorDomain,
    );
    expect(await governanceRouter.governor()).to.equal(expectedGovernor);
  }

  before(async () => {
    [thirdRouter, signer, secondSigner] = await ethers.getSigners();
    validator = await Validator.fromSigner(signer, governorDomain);
  });

  beforeEach(async () => {
    abacusDeployment = await AbacusDeployment.fromDomains(domains, signer);
    governanceDeployment = await GovernanceDeployment.fromAbacusDeployment(
      abacusDeployment,
      signer,
    );

    firstGovernor = await signer.getAddress();
    secondGovernor = await secondSigner.getAddress();

    governorRouter = governanceDeployment.router(governorDomain);
    nonGovernorRouter = governanceDeployment.router(nonGovernorDomain);

    governorInboxOnNonGovernorChain = abacusDeployment.inbox(
      nonGovernorDomain,
      governorDomain,
    );
    nonGovernorInboxOnGovernorChain = abacusDeployment.inbox(
      governorDomain,
      nonGovernorDomain,
    );

    governorOutbox = abacusDeployment.outbox(governorDomain);
  });

  // NB: must be first test for message proof
  it('Sends cross-chain message to upgrade contract', async () => {
    const upgradeUtils = new UpgradeTestHelpers();

    // get upgradeBeaconController
    const ubc = abacusDeployment.ubc(nonGovernorDomain);
    // Transfer ownership of the UBC to governance.
    await ubc.transferOwnership(nonGovernorRouter.address);
    const mysteryMath = await upgradeUtils.deployMysteryMathUpgradeSetup(
      signer,
      ubc,
    );

    // expect results before upgrade
    await upgradeUtils.expectMysteryMathV1(mysteryMath.proxy);

    // Deploy Implementation 2
    const factory2 = new MysteryMathV2__factory(signer);
    const implementation2 = await factory2.deploy();

    // Format abacus call message
    const call = await formatCall(ubc, 'upgrade', [
      mysteryMath.beacon.address,
      implementation2.address,
    ]);

    // dispatch call on local governorRouter
    let tx = await governorRouter.callRemote(nonGovernorDomain, [call]);

    await abacusDeployment.processMessagesFromDomain(governorDomain);
    // test implementation was upgraded
    await upgradeUtils.expectMysteryMathV2(mysteryMath.proxy);
  });

  it('Rejects message from unenrolled inbox', async () => {
    const inboxFactory = new TestInbox__factory(signer);
    const unenrolledInbox = await inboxFactory.deploy(
      nonGovernorDomain,
      processGas,
      reserveGas,
    );
    // The ValdiatorManager is unused in this test, but needs to be a contract.
    await unenrolledInbox.initialize(
      thirdDomain,
      unenrolledInbox.address,
      nullRoot,
      0,
    );

    // Create TransferGovernor message
    const transferGovernorMessage = abacus.governance.formatTransferGovernor(
      thirdDomain,
      abacus.ethersAddressToBytes32(secondGovernor),
    );

    const abacusMessage = await formatAbacusMessage(
      unenrolledInbox,
      governorRouter,
      nonGovernorRouter,
      transferGovernorMessage,
    );

    // Expect inbox processing to fail when nonGovernorRouter reverts in handle
    let success = await unenrolledInbox.callStatic.testProcess(abacusMessage);
    expect(success).to.be.false;
  });

  it('Rejects message not from governor router', async () => {
    // Create TransferGovernor message
    const transferGovernorMessage = abacus.governance.formatTransferGovernor(
      nonGovernorDomain,
      abacus.ethersAddressToBytes32(nonGovernorRouter.address),
    );

    const abacusMessage = await formatAbacusMessage(
      governorInboxOnNonGovernorChain,
      nonGovernorRouter,
      governorRouter,
      transferGovernorMessage,
    );

    // Set message status to MessageStatus.Proven
    await nonGovernorInboxOnGovernorChain.setMessageProven(abacusMessage);

    // Expect inbox processing to fail when nonGovernorRouter reverts in handle
    let success = await nonGovernorInboxOnGovernorChain.callStatic.testProcess(
      abacusMessage,
    );
    expect(success).to.be.false;
  });

  it('Accepts a valid transfer governor message', async () => {
    // Enroll router for new domain (in real setting this would
    // be executed with an Abacus message sent to the nonGovernorRouter)
    await nonGovernorRouter.testSetRouter(
      thirdDomain,
      abacus.ethersAddressToBytes32(thirdRouter.address),
    );

    // Create TransferGovernor message
    const transferGovernorMessage = abacus.governance.formatTransferGovernor(
      thirdDomain,
      abacus.ethersAddressToBytes32(thirdRouter.address),
    );

    const abacusMessage = await formatAbacusMessage(
      governorInboxOnNonGovernorChain,
      governorRouter,
      nonGovernorRouter,
      transferGovernorMessage,
    );

    // Expect successful tx on static call
    let success = await governorInboxOnNonGovernorChain.callStatic.process(
      abacusMessage,
    );
    expect(success).to.be.true;

    await governorInboxOnNonGovernorChain.process(abacusMessage);
    await expectGovernor(
      nonGovernorRouter,
      thirdDomain,
      ethers.constants.AddressZero,
    );
  });

  it('Accepts valid set router message', async () => {
    // Create address for router to enroll and domain for router
    const [router] = await ethers.getSigners();

    // Create SetRouter message
    const setRouterMessage = abacus.governance.formatSetRouter(
      thirdDomain,
      abacus.ethersAddressToBytes32(router.address),
    );

    const abacusMessage = await formatAbacusMessage(
      governorInboxOnNonGovernorChain,
      governorRouter,
      nonGovernorRouter,
      setRouterMessage,
    );

    // Expect successful tx
    let success = await governorInboxOnNonGovernorChain.callStatic.process(
      abacusMessage,
    );
    expect(success).to.be.true;

    // Expect new router to be registered for domain and for new domain to be
    // in domains array
    await governorInboxOnNonGovernorChain.process(abacusMessage);
    expect(await nonGovernorRouter.routers(thirdDomain)).to.equal(
      abacus.ethersAddressToBytes32(router.address),
    );
    expect(await nonGovernorRouter.containsDomain(thirdDomain)).to.be.true;
  });

  it('Accepts valid call messages', async () => {
    // const TestRecipient = await abacus.deployImplementation('TestRecipient');
    const testRecipientFactory = new TestRecipient__factory(signer);
    const testRecipient = await testRecipientFactory.deploy();

    // Format abacus call message
    const arg = 'String!';
    const call = await formatCall(testRecipient, 'receiveString', [arg]);

    // Create Call message to test recipient that calls receiveString
    const callMessage = abacus.governance.formatCalls([call, call]);

    const abacusMessage = await formatAbacusMessage(
      governorInboxOnNonGovernorChain,
      governorRouter,
      nonGovernorRouter,
      callMessage,
    );

    // Expect successful tx
    let success = await governorInboxOnNonGovernorChain.callStatic.testProcess(
      abacusMessage,
    );

    expect(success).to.be.true;
  });

  it('Transfers governorship', async () => {
    // Transfer governor on current governor chain

    // Governor HAS NOT been transferred on original governor domain
    await expectGovernor(governorRouter, governorDomain, firstGovernor);
    // Governor HAS NOT been transferred on original non-governor domain
    await expectGovernor(
      nonGovernorRouter,
      governorDomain,
      ethers.constants.AddressZero,
    );

    // transfer governorship to nonGovernorRouter
    await governorRouter.transferGovernor(nonGovernorDomain, secondGovernor);

    // Governor HAS been transferred on original governor domain
    await expectGovernor(
      governorRouter,
      nonGovernorDomain,
      ethers.constants.AddressZero,
    );
    // Governor HAS NOT been transferred on original non-governor domain
    await expectGovernor(
      nonGovernorRouter,
      governorDomain,
      ethers.constants.AddressZero,
    );

    const transferGovernorMessage = abacus.governance.formatTransferGovernor(
      nonGovernorDomain,
      abacus.ethersAddressToBytes32(secondGovernor),
    );

    const abacusMessage = await formatAbacusMessage(
      governorInboxOnNonGovernorChain,
      governorRouter,
      nonGovernorRouter,
      transferGovernorMessage,
    );

    // Process transfer governor message on Inbox
    await governorInboxOnNonGovernorChain.process(abacusMessage);

    // Governor HAS been transferred on original governor domain
    await expectGovernor(
      governorRouter,
      nonGovernorDomain,
      ethers.constants.AddressZero,
    );
    // Governor HAS been transferred on original non-governor domain
    await expectGovernor(nonGovernorRouter, nonGovernorDomain, secondGovernor);
  });

  it('Upgrades using GovernanceRouter call', async () => {
    const upgradeUtils = new UpgradeTestHelpers();

    // get upgradeBeaconController
    const ubc = abacusDeployment.ubc(governorDomain);
    // Transfer ownership of the UBC to governance.
    await ubc.transferOwnership(governorRouter.address);
    const mysteryMath = await upgradeUtils.deployMysteryMathUpgradeSetup(
      signer,
      ubc,
    );

    // expect results before upgrade
    await upgradeUtils.expectMysteryMathV1(mysteryMath.proxy);

    // Deploy Implementation 2
    const v2Factory = new MysteryMathV2__factory(signer);
    const implementation = await v2Factory.deploy();

    // Format abacus call message
    const call = await formatCall(ubc, 'upgrade', [
      mysteryMath.beacon.address,
      implementation.address,
    ]);

    // dispatch call on local governorRouter
    await expect(governorRouter.callLocal([call])).to.emit(
      ubc,
      'BeaconUpgraded',
    );

    // test implementation was upgraded
    await upgradeUtils.expectMysteryMathV2(mysteryMath.proxy);
  });

  it('Calls ValidatorManager to set the validator for a domain', async () => {
    const [newValidator] = await ethers.getSigners();
    const validatorManager = abacusDeployment.validatorManager(governorDomain);
    await validatorManager.transferOwnership(governorRouter.address);

    // check current Validator address on Outbox
    let currentValidatorAddr = await validatorManager.validators(
      governorDomain,
    );
    expect(currentValidatorAddr).to.equal(
      await abacusDeployment.validator(governorDomain).signer.getAddress(),
    );

    // format abacus call message
    const call = await formatCall(validatorManager, 'setValidator', [
      governorDomain,
      newValidator.address,
    ]);

    await expect(governorRouter.callLocal([call])).to.emit(
      validatorManager,
      'NewValidator',
    );

    // check for new validator
    currentValidatorAddr = await validatorManager.validators(governorDomain);
    expect(currentValidatorAddr).to.equal(newValidator.address);
  });
});
