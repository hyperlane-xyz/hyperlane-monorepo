import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { pino } from 'pino';
import Sinon from 'sinon';

import { RebalancerStrategyOptions } from '@hyperlane-xyz/sdk';

import { RebalancingRoute } from '../interfaces/IStrategy.js';
import { MockRebalancer, buildTestConfig } from '../test/helpers.js';

import { WithSemaphore } from './WithSemaphore.js';

chai.use(chaiAsPromised);

const testLogger = pino({ level: 'silent' });

describe('WithSemaphore', () => {
  it('should call the underlying rebalancer', async () => {
    const config = buildTestConfig();

    const routes = [
      {
        origin: 'chain1',
      } as any as RebalancingRoute,
    ];

    const rebalancer = new MockRebalancer();
    const rebalanceSpy = Sinon.spy(rebalancer, 'rebalance');
    const withSemaphore = new WithSemaphore(config, rebalancer, testLogger);
    await withSemaphore.rebalance(routes);

    expect(rebalanceSpy.calledOnce).to.be.true;
    expect(rebalanceSpy.calledWith(routes)).to.be.true;
  });

  it('should return early if there are no routes', async () => {
    const config = buildTestConfig();

    const rebalancer = new MockRebalancer();
    const rebalanceSpy = Sinon.spy(rebalancer, 'rebalance');
    const withSemaphore = new WithSemaphore(config, rebalancer, testLogger);
    await withSemaphore.rebalance([]);

    expect(rebalanceSpy.calledOnce).to.be.false;
  });

  it('should return early if rebalance occurs before waitUntil is reached', async () => {
    const config = buildTestConfig();

    const routes = [
      {
        origin: 'chain1',
      } as any as RebalancingRoute,
    ];

    const rebalancer = new MockRebalancer();
    const rebalanceSpy = Sinon.spy(rebalancer, 'rebalance');
    const withSemaphore = new WithSemaphore(config, rebalancer, testLogger);
    await withSemaphore.rebalance(routes);

    expect(rebalanceSpy.calledOnce).to.be.true;
    expect(rebalanceSpy.calledWith(routes)).to.be.true;

    rebalanceSpy.resetHistory();
    await withSemaphore.rebalance(routes);

    expect(rebalanceSpy.calledOnce).to.be.false;
  });

  it('should throw if a chain is missing', async () => {
    const config = buildTestConfig({
      strategyConfig: {
        rebalanceStrategy: RebalancerStrategyOptions.Weighted,
        chains: {},
      },
    });

    const routes = [
      {
        origin: 'chain1',
      } as any as RebalancingRoute,
    ];

    const rebalancer = new MockRebalancer();
    const withSemaphore = new WithSemaphore(config, rebalancer, testLogger);

    await expect(withSemaphore.rebalance(routes)).to.be.rejectedWith(
      `Chain ${routes[0].origin} not found in config`,
    );
  });

  it('should not execute if another rebalance is currently executing', async () => {
    const config = buildTestConfig();

    const routes = [
      {
        origin: 'chain1',
      } as any as RebalancingRoute,
    ];

    const rebalancer = new MockRebalancer();
    const rebalanceSpy = Sinon.spy(rebalancer, 'rebalance');
    const withSemaphore = new WithSemaphore(config, rebalancer, testLogger);

    const rebalancePromise1 = withSemaphore.rebalance(routes);
    const rebalancePromise2 = withSemaphore.rebalance(routes);
    await rebalancePromise1;
    await rebalancePromise2;

    expect(rebalanceSpy.calledOnce).to.be.true;
  });
});
