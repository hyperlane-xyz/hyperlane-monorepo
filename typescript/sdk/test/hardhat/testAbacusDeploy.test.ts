import '@nomiclabs/hardhat-ethers';
import '@nomiclabs/hardhat-waffle';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import { TestOutbox, TestRecipient__factory } from '@abacus-network/core';
import { chainMetadata } from '@abacus-network/sdk';
import { utils } from '@abacus-network/utils';

import { TestCoreApp } from '../../src/hardhat/TestCoreApp';
import { TestCoreDeployer } from '../../src/hardhat/TestCoreDeployer';
import { hardhatMultiProvider } from '../../src/hardhat/hardhatMultiProvider';

const localChain = 'test1';
const localDomain = chainMetadata[localChain].id;
const remoteChain = 'test2';
const remoteDomain = chainMetadata[remoteChain].id;
const message = '0xdeadbeef';

describe('TestCoreDeployer', async () => {
  let abacus: TestCoreApp, localOutbox: TestOutbox, remoteOutbox: TestOutbox;

  beforeEach(async () => {
    const [signer] = await ethers.getSigners();
    const multiProvider = hardhatMultiProvider(ethers.provider, signer);
    const deployer = new TestCoreDeployer(multiProvider);
    abacus = await deployer.deployApp();

    const recipient = await new TestRecipient__factory(signer).deploy();
    localOutbox = abacus.getContracts(localChain).outbox.contract;
    await expect(
      localOutbox.dispatch(
        remoteDomain,
        utils.addressToBytes32(recipient.address),
        message,
      ),
    ).to.emit(localOutbox, 'Dispatch');
    remoteOutbox = abacus.getContracts(remoteChain).outbox.contract;
    await expect(
      remoteOutbox.dispatch(
        localDomain,
        utils.addressToBytes32(recipient.address),
        message,
      ),
    ).to.emit(remoteOutbox, 'Dispatch');
  });

  it('processes outbound messages for a single domain', async () => {
    const responses = await abacus.processOutboundMessages(localChain);
    expect(responses.get(remoteChain)!.length).to.equal(1);
  });

  it('processes outbound messages for two domains', async () => {
    const localResponses = await abacus.processOutboundMessages(localChain);
    expect(localResponses.get(remoteChain)!.length).to.equal(1);
    const remoteResponses = await abacus.processOutboundMessages(remoteChain);
    expect(remoteResponses.get(localChain)!.length).to.equal(1);
  });

  it('processes all messages', async () => {
    const responses = await abacus.processMessages();
    expect(responses.get(localChain)!.get(remoteChain)!.length).to.equal(1);
    expect(responses.get(remoteChain)!.get(localChain)!.length).to.equal(1);
  });
});
