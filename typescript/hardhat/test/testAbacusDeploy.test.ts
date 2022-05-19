import { hardhatMultiProvider } from '../index';
import { TestCoreApp } from '../src/TestCoreApp';
import { TestCoreDeploy } from '../src/TestCoreDeploy';
import { TestOutbox, TestRecipient__factory } from '@abacus-network/core';
import { chainMetadata } from '@abacus-network/sdk';
import { utils } from '@abacus-network/utils';
import { expect } from 'chai';
import { ethers } from 'hardhat';

const localChain = 'test1';
const localDomain = chainMetadata[localChain].id;
const remoteChain = 'test2';
const remoteDomain = chainMetadata[remoteChain].id;
const message = '0xdeadbeef';

describe('TestCoreDeploy', async () => {
  let abacus: TestCoreApp, localOutbox: TestOutbox, remoteOutbox: TestOutbox;

  beforeEach(async () => {
    const [signer] = await ethers.getSigners();
    const multiProvider = hardhatMultiProvider(ethers, signer);
    const deployer = new TestCoreDeploy(multiProvider);
    abacus = await deployer.deployCore();

    const recipient = await new TestRecipient__factory(signer).deploy();
    localOutbox = abacus.getContracts(localChain).outbox.outbox;
    await expect(
      localOutbox.dispatch(
        remoteDomain,
        utils.addressToBytes32(recipient.address),
        message,
      ),
    ).to.emit(localOutbox, 'Dispatch');
    remoteOutbox = abacus.getContracts(remoteChain).outbox.outbox;
    await expect(
      remoteOutbox.dispatch(
        localDomain,
        utils.addressToBytes32(recipient.address),
        message,
      ),
    ).to.emit(remoteOutbox, 'Dispatch');
  });

  describe('without a created checkpoint', () => {
    it('does not process outbound messages', async () => {
      const responses = await abacus.processOutboundMessages(localChain);
      expect(responses.get(remoteChain)).to.be.undefined;
    });
  });

  describe('with a checkpoint', () => {
    beforeEach(async () => {
      await localOutbox.checkpoint();
      await remoteOutbox.checkpoint();
    });

    it('processes outbound messages for a single domain', async () => {
      const responses = await abacus.processOutboundMessages(localChain);
      expect(responses.get(remoteChain)!.length).to.equal(1);
      const [_, index] = await localOutbox.latestCheckpoint();
      expect(index).to.equal(1);
    });

    it('processes outbound messages for two domains', async () => {
      const localResponses = await abacus.processOutboundMessages(localChain);
      expect(localResponses.get(remoteChain)!.length).to.equal(1);
      const [, localIndex] = await localOutbox.latestCheckpoint();
      expect(localIndex).to.equal(1);
      const remoteResponses = await abacus.processOutboundMessages(remoteChain);
      expect(remoteResponses.get(localChain)!.length).to.equal(1);
      const [, remoteIndex] = await remoteOutbox.latestCheckpoint();
      expect(remoteIndex).to.equal(1);
    });

    it('processes all messages', async () => {
      const responses = await abacus.processMessages();
      expect(responses.get(localChain)!.get(remoteChain)!.length).to.equal(1);
      expect(responses.get(remoteChain)!.get(localChain)!.length).to.equal(1);
      const [, localIndex] = await localOutbox.latestCheckpoint();
      expect(localIndex).to.equal(1);
      const [, remoteIndex] = await remoteOutbox.latestCheckpoint();
      expect(remoteIndex).to.equal(1);
    });
  });
});
