import { expect } from 'chai';
import Sinon from 'sinon';

import { Config } from '../config/Config.js';
import { IExecutor } from '../interfaces/IExecutor.js';
import { RebalancingRoute } from '../interfaces/IStrategy.js';

import { WithSemaphore } from './WithSemaphore.js';

class MockExecutor implements IExecutor {
  rebalance(_routes: RebalancingRoute[]): Promise<void> {
    return Promise.resolve();
  }
}

describe('WithSemaphore', () => {
  it('should call the underlying executor', async () => {
    const config = {
      chains: {
        chain1: {
          bridgeTolerance: 1,
        },
      },
    } as any as Config;

    const routes = [
      {
        fromChain: 'chain1',
      } as any as RebalancingRoute,
    ];

    const executor = new MockExecutor();
    const rebalanceSpy = Sinon.spy(executor, 'rebalance');
    const withSemaphore = new WithSemaphore(config, executor);
    await withSemaphore.rebalance(routes);

    expect(rebalanceSpy.calledOnce).to.be.true;
    expect(rebalanceSpy.calledWith(routes)).to.be.true;
  });

  it('should return early if there are no routes', async () => {
    const config = {
      chains: {
        chain1: {
          bridgeTolerance: 1,
        },
      },
    } as any as Config;

    const executor = new MockExecutor();
    const rebalanceSpy = Sinon.spy(executor, 'rebalance');
    const withSemaphore = new WithSemaphore(config, executor);
    await withSemaphore.rebalance([]);

    expect(rebalanceSpy.calledOnce).to.be.false;
  });

  it('should return early if the rebalance is still in progress', async () => {
    const config = {
      chains: {
        chain1: {
          bridgeTolerance: 1,
        },
      },
    } as any as Config;

    const routes = [
      {
        fromChain: 'chain1',
      } as any as RebalancingRoute,
    ];

    const executor = new MockExecutor();
    const rebalanceSpy = Sinon.spy(executor, 'rebalance');
    const withSemaphore = new WithSemaphore(config, executor);
    await withSemaphore.rebalance(routes);

    expect(rebalanceSpy.calledOnce).to.be.true;
    expect(rebalanceSpy.calledWith(routes)).to.be.true;

    await withSemaphore.rebalance(routes);
    rebalanceSpy.resetHistory();

    expect(rebalanceSpy.calledOnce).to.be.false;
  });
});
