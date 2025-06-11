import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import Sinon from 'sinon';

import { RebalancerConfig } from '../config/RebalancerConfig.js';
import { IRebalancer } from '../interfaces/IRebalancer.js';
import { RebalancingRoute } from '../interfaces/IStrategy.js';

import { WithSemaphore } from './WithSemaphore.js';

chai.use(chaiAsPromised);

class MockRebalancer implements IRebalancer {
  rebalance(_routes: RebalancingRoute[]): Promise<void> {
    return Promise.resolve();
  }
}

describe('WithSemaphore', () => {
  it('should call the underlying rebalancer', async () => {
    const config = {
      strategyConfig: {
        chains: {
          chain1: {
            bridgeLockTime: 1,
          },
        },
      },
    } as any as RebalancerConfig;

    const routes = [
      {
        origin: 'chain1',
      } as any as RebalancingRoute,
    ];

    const rebalancer = new MockRebalancer();
    const rebalanceSpy = Sinon.spy(rebalancer, 'rebalance');
    const withSemaphore = new WithSemaphore(config, rebalancer);
    await withSemaphore.rebalance(routes);

    expect(rebalanceSpy.calledOnce).to.be.true;
    expect(rebalanceSpy.calledWith(routes)).to.be.true;
  });

  it('should return early if there are no routes', async () => {
    const config = {
      strategyConfig: {
        chains: {
          chain1: {
            bridgeLockTime: 1,
          },
        },
      },
    } as any as RebalancerConfig;

    const rebalancer = new MockRebalancer();
    const rebalanceSpy = Sinon.spy(rebalancer, 'rebalance');
    const withSemaphore = new WithSemaphore(config, rebalancer);
    await withSemaphore.rebalance([]);

    expect(rebalanceSpy.calledOnce).to.be.false;
  });

  it('should return early if rebalance occurs before waitUntil is reached', async () => {
    const config = {
      strategyConfig: {
        chains: {
          chain1: {
            bridgeLockTime: 1,
          },
        },
      },
    } as any as RebalancerConfig;

    const routes = [
      {
        origin: 'chain1',
      } as any as RebalancingRoute,
    ];

    const rebalancer = new MockRebalancer();
    const rebalanceSpy = Sinon.spy(rebalancer, 'rebalance');
    const withSemaphore = new WithSemaphore(config, rebalancer);
    await withSemaphore.rebalance(routes);

    expect(rebalanceSpy.calledOnce).to.be.true;
    expect(rebalanceSpy.calledWith(routes)).to.be.true;

    rebalanceSpy.resetHistory();
    await withSemaphore.rebalance(routes);

    expect(rebalanceSpy.calledOnce).to.be.false;
  });

  it('should throw if a chain is missing', async () => {
    const config = {
      strategyConfig: {
        chains: {},
      },
    } as any as RebalancerConfig;

    const routes = [
      {
        origin: 'chain1',
      } as any as RebalancingRoute,
    ];

    const rebalancer = new MockRebalancer();
    const withSemaphore = new WithSemaphore(config, rebalancer);

    await expect(withSemaphore.rebalance(routes)).to.be.rejectedWith(
      `Chain ${routes[0].origin} not found in config`,
    );
  });

  it('should not execute if another rebalance is currently executing', async () => {
    const config = {
      strategyConfig: {
        chains: {
          chain1: {
            bridgeLockTime: 1,
          },
        },
      },
    } as any as RebalancerConfig;

    const routes = [
      {
        origin: 'chain1',
      } as any as RebalancingRoute,
    ];

    const rebalancer = new MockRebalancer();
    const rebalanceSpy = Sinon.spy(rebalancer, 'rebalance');
    const withSemaphore = new WithSemaphore(config, rebalancer);

    const rebalancePromise1 = withSemaphore.rebalance(routes);
    const rebalancePromise2 = withSemaphore.rebalance(routes);
    await rebalancePromise1;
    await rebalancePromise2;

    expect(rebalanceSpy.calledOnce).to.be.true;
  });
});
