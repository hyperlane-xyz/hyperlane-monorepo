import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import Sinon from 'sinon';

import { Config } from '../config/Config.js';
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
      chains: {
        chain1: {
          bridgeLockTime: 1,
        },
      },
    } as any as Config;

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
      chains: {
        chain1: {
          bridgeLockTime: 1,
        },
      },
    } as any as Config;

    const rebalancer = new MockRebalancer();
    const rebalanceSpy = Sinon.spy(rebalancer, 'rebalance');
    const withSemaphore = new WithSemaphore(config, rebalancer);
    await withSemaphore.rebalance([]);

    expect(rebalanceSpy.calledOnce).to.be.false;
  });

  it('should return early if rebalance occurs before waitUntil is reached', async () => {
    const config = {
      chains: {
        chain1: {
          bridgeLockTime: 1,
        },
      },
    } as any as Config;

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
      chains: {},
    } as any as Config;

    const routes = [
      {
        origin: 'chain1',
      } as any as RebalancingRoute,
    ];

    const rebalancer = new MockRebalancer();
    const withSemaphore = new WithSemaphore(config, rebalancer);

    await expect(withSemaphore.rebalance(routes)).to.be.rejectedWith(
      "Cannot read properties of undefined (reading 'bridgeLockTime')",
    );
  });

  it('should not execute if another rebalance is currently executing', async () => {
    const config = {
      chains: {
        chain1: {
          bridgeLockTime: 1,
        },
      },
    } as any as Config;

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
