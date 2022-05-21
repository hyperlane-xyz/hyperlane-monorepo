import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import { MessageStatus } from '@abacus-network/utils/dist/src/types';

import {
  TestInbox,
  TestInbox__factory,
  TestRecipient__factory,
} from '../types';

const localDomain = 3000;
const remoteDomain = 1000;

describe('Inbox', async () => {
  let inbox: TestInbox, signer: SignerWithAddress;

  before(async () => {
    [signer] = await ethers.getSigners();
  });

  beforeEach(async () => {
    const inboxFactory = new TestInbox__factory(signer);
    inbox = await inboxFactory.deploy(localDomain);
    await inbox.initialize(remoteDomain, inbox.address);
  });

  it('Cannot be initialized twice', async () => {
    await expect(
      inbox.initialize(remoteDomain, inbox.address),
    ).to.be.revertedWith('Initializable: contract is already initialized');
  });

  it('Processes a valid message', async () => {
    const signers = await ethers.getSigners();
    const recipientF = new TestRecipient__factory(signers[signers.length - 1]);
    const recipient = await recipientF.deploy();
    await recipient.deployTransaction.wait();
    const message =
      '0x000003e8000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb9226600000bb800000000000000000000000073511669fd4de447fed18bb79bafeac93ab7f31f1234';
    // Random 32 bytes
    const baseCommitment =
      '0xc62bbe990c8ecd7f1771bb353a516fb486fecf3b5987ecebc4d064d3586e2711';
    const commitment = ethers.utils.solidityKeccak256(
      ['bytes32', 'bytes'],
      [baseCommitment, message],
    );

    await inbox.process(message, baseCommitment, commitment, '0x');
    expect(await inbox.messages(commitment)).to.eql(MessageStatus.PROCESSED);
  });

  it('Rejects an already-processed message', async () => {
    const message =
      '0x000003e8000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb9226600000bb800000000000000000000000073511669fd4de447fed18bb79bafeac93ab7f31f1234';
    // Random 32 bytes
    const baseCommitment =
      '0xc62bbe990c8ecd7f1771bb353a516fb486fecf3b5987ecebc4d064d3586e2711';
    const commitment = ethers.utils.solidityKeccak256(
      ['bytes32', 'bytes'],
      [baseCommitment, message],
    );

    // Set message status as MessageStatus.Processed
    await inbox.setMessageStatus(commitment, MessageStatus.PROCESSED);

    // Try to process message again
    await expect(
      inbox.process(message, baseCommitment, commitment, '0x'),
    ).to.be.revertedWith('!MessageStatus.None');
  });
});
