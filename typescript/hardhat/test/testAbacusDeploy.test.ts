import { TestAbacusDeploy } from '..';
import { TestRecipient__factory } from '@abacus-network/core';
import { utils } from '@abacus-network/utils';
import { expect } from 'chai';
import { ethers } from 'hardhat';

const localDomain = 1000;
const remoteDomain = 2000;
const domains = [localDomain, remoteDomain];
const message = '0xdeadbeef';

describe('TestAbacusDeploy', async () => {
  let abacus: TestAbacusDeploy;

  beforeEach(async () => {
    abacus = new TestAbacusDeploy({ signer: {} });
    const [signer] = await ethers.getSigners();
    await abacus.deploy(domains, signer);

    const recipient = await new TestRecipient__factory(signer).deploy();
    const localOutbox = abacus.outbox(localDomain);
    await expect(
      localOutbox.dispatch(
        remoteDomain,
        utils.addressToBytes32(recipient.address),
        message,
      ),
    ).to.emit(localOutbox, 'Dispatch');
    const remoteOutbox = abacus.outbox(remoteDomain);
    await expect(
      remoteOutbox.dispatch(
        localDomain,
        utils.addressToBytes32(recipient.address),
        message,
      ),
    ).to.emit(remoteOutbox, 'Dispatch');
  });

  it('processes outbound messages for a single domain', async () => {
    const responses = await abacus.processOutboundMessages(localDomain);
    expect(responses.get(remoteDomain)!.length).to.equal(1);
  });

  it('processes outbound messages for two domains', async () => {
    const localResponses = await abacus.processOutboundMessages(localDomain);
    expect(localResponses.get(remoteDomain)!.length).to.equal(1);
    const remoteResponses = await abacus.processOutboundMessages(remoteDomain);
    expect(remoteResponses.get(localDomain)!.length).to.equal(1);
  });

  it('processes all messages', async () => {
    const responses = await abacus.processMessages();
    expect(responses.get(localDomain)!.get(remoteDomain)!.length).to.equal(1);
    expect(responses.get(remoteDomain)!.get(localDomain)!.length).to.equal(1);
  });
});
