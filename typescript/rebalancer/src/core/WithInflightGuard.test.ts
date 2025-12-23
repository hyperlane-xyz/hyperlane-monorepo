import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { ethers } from 'ethers';
import { pino } from 'pino';
import Sinon from 'sinon';

import { chainMetadata } from '@hyperlane-xyz/registry';
import { ChainMetadataManager } from '@hyperlane-xyz/sdk';

import { RebalancingRoute } from '../interfaces/IStrategy.js';
import { MockRebalancer, buildTestConfig } from '../test/helpers.js';
import { ExplorerClient } from '../utils/ExplorerClient.js';

import { WithInflightGuard } from './WithInflightGuard.js';

chai.use(chaiAsPromised);

const testLogger = pino({ level: 'silent' });

describe('WithInflightGuard', () => {
  it('forwards empty routes without calling Explorer', async () => {
    const config = buildTestConfig();

    const rebalancer = new MockRebalancer();
    const rebalanceSpy = Sinon.spy(rebalancer, 'rebalance');

    const explorer = new ExplorerClient('http://localhost');
    const explorerSpy = Sinon.stub(explorer, 'hasUndeliveredRebalance');

    const guard = new WithInflightGuard(
      config,
      rebalancer,
      explorer,
      ethers.Wallet.createRandom().address,
      new ChainMetadataManager(chainMetadata as any),
      testLogger,
    );

    await guard.rebalance([]);

    expect(explorerSpy.called).to.be.false;
    expect(rebalanceSpy.calledOnce).to.be.true;
    expect(rebalanceSpy.calledWith([])).to.be.true;
  });

  it('calls underlying rebalancer when no inflight is detected', async () => {
    const config = buildTestConfig({}, ['ethereum', 'arbitrum']);
    const routes: RebalancingRoute[] = [{ origin: 'ethereum' } as any];

    const rebalancer = new MockRebalancer();
    const rebalanceSpy = Sinon.spy(rebalancer, 'rebalance');

    const explorer = new ExplorerClient('http://localhost');
    const explorerSpy = Sinon.stub(
      explorer,
      'hasUndeliveredRebalance',
    ).resolves(false);

    const guard = new WithInflightGuard(
      config,
      rebalancer,
      explorer,
      ethers.Wallet.createRandom().address,
      new ChainMetadataManager(chainMetadata as any),
      testLogger,
    );

    await guard.rebalance(routes);

    expect(explorerSpy.calledOnce).to.be.true;
    expect(rebalanceSpy.calledOnce).to.be.true;
    expect(rebalanceSpy.calledWith(routes)).to.be.true;
  });

  it('skips rebalancing when inflight is detected', async () => {
    const config = buildTestConfig({}, ['ethereum', 'arbitrum']);
    const routes: RebalancingRoute[] = [{ origin: 'ethereum' } as any];

    const rebalancer = new MockRebalancer();
    const rebalanceSpy = Sinon.spy(rebalancer, 'rebalance');

    const explorer = new ExplorerClient('http://localhost');
    const explorerSpy = Sinon.stub(
      explorer,
      'hasUndeliveredRebalance',
    ).resolves(true);

    const guard = new WithInflightGuard(
      config,
      rebalancer,
      explorer,
      ethers.Wallet.createRandom().address,
      new ChainMetadataManager(chainMetadata as any),
      testLogger,
    );

    await guard.rebalance(routes);

    expect(explorerSpy.calledOnce).to.be.true;
    expect(rebalanceSpy.called).to.be.false;
  });

  it('propagates explorer query error', async () => {
    const config = buildTestConfig({}, ['ethereum', 'arbitrum']);
    const routes: RebalancingRoute[] = [{ origin: 'ethereum' } as any];

    const rebalancer = new MockRebalancer();
    const rebalanceSpy = Sinon.spy(rebalancer, 'rebalance');

    const explorer = new ExplorerClient('http://localhost');
    const explorerSpy = Sinon.stub(explorer, 'hasUndeliveredRebalance').rejects(
      new Error('Explorer HTTP 405'),
    );

    const guard = new WithInflightGuard(
      config,
      rebalancer,
      explorer,
      ethers.Wallet.createRandom().address,
      new ChainMetadataManager(chainMetadata as any),
      testLogger,
    );

    await expect(guard.rebalance(routes)).to.be.rejectedWith(
      'Explorer HTTP 405',
    );

    expect(explorerSpy.calledOnce).to.be.true;
    expect(rebalanceSpy.called).to.be.false;
  });
});
