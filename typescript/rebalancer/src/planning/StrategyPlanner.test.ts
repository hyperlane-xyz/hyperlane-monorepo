import { expect } from 'chai';
import { ethers } from 'ethers';
import { pino } from 'pino';
import Sinon from 'sinon';

import type { ChainMap, Token } from '@hyperlane-xyz/sdk';

import type { RawBalances, StrategyRoute } from '../interfaces/IStrategy.js';
import type { Metrics } from '../metrics/Metrics.js';
import { TEST_ADDRESSES } from '../test/helpers.js';
import type { RouteExecutionMatrix } from '../utils/bridgeUtils.js';

import { StrategyPlanner } from './StrategyPlanner.js';

const testLogger = pino({ level: 'silent' });

describe('StrategyPlanner', () => {
  function createMockToken(chainName: string, decimals = 18): Token {
    return {
      chainName,
      decimals,
      addressOrDenom: TEST_ADDRESSES.token,
    } as unknown as Token;
  }

  const routeExecutionMatrix: RouteExecutionMatrix = {
    ethereum: {
      arbitrum: {
        executionType: 'movableCollateral',
        bridge: TEST_ADDRESSES.bridge,
        bridgeMinAcceptedAmount: '100',
      },
    },
    arbitrum: {
      ethereum: {
        executionType: 'movableCollateral',
        bridge: TEST_ADDRESSES.bridge,
      },
    },
    optimism: {
      ethereum: {
        executionType: 'movableCollateral',
        bridge: TEST_ADDRESSES.bridge,
      },
    },
  };

  const tokensByChainName: ChainMap<Token> = {
    ethereum: createMockToken('ethereum'),
    arbitrum: createMockToken('arbitrum'),
    optimism: createMockToken('optimism'),
  };

  it('filters routes by actual origin balance and bridgeMinAcceptedAmount', () => {
    const planner = new StrategyPlanner(
      routeExecutionMatrix,
      testLogger,
      undefined,
      tokensByChainName,
    );
    const routes: StrategyRoute[] = [
      {
        origin: 'arbitrum',
        destination: 'ethereum',
        amount: 10n,
        executionType: 'movableCollateral',
        bridge: TEST_ADDRESSES.bridge,
      },
      {
        origin: 'ethereum',
        destination: 'arbitrum',
        amount: ethers.utils.parseEther('50').toBigInt(),
        executionType: 'movableCollateral',
        bridge: TEST_ADDRESSES.bridge,
      },
      {
        origin: 'optimism',
        destination: 'ethereum',
        amount: 25n,
        executionType: 'movableCollateral',
        bridge: TEST_ADDRESSES.bridge,
      },
    ];
    const actualBalances: RawBalances = {
      ethereum: ethers.utils.parseEther('1000').toBigInt(),
      arbitrum: 5n,
      optimism: 25n,
    };

    const filteredRoutes = planner.finalizeRoutes(
      routes,
      actualBalances,
      'weighted',
      'TestStrategy',
    );

    expect(filteredRoutes).to.deep.equal([routes[2]]);
  });

  it('records intent metrics only for routes kept after filtering', () => {
    const recordIntentCreated = Sinon.stub();
    const metrics = {
      recordIntentCreated,
    } as unknown as Metrics;
    const planner = new StrategyPlanner(
      routeExecutionMatrix,
      testLogger,
      metrics,
      tokensByChainName,
    );
    const keptRoute: StrategyRoute = {
      origin: 'optimism',
      destination: 'ethereum',
      amount: 25n,
      executionType: 'movableCollateral',
      bridge: TEST_ADDRESSES.bridge,
    };
    const droppedRoute: StrategyRoute = {
      origin: 'arbitrum',
      destination: 'ethereum',
      amount: 10n,
      executionType: 'movableCollateral',
      bridge: TEST_ADDRESSES.bridge,
    };

    planner.finalizeRoutes(
      [droppedRoute, keptRoute],
      {
        ethereum: 100n,
        arbitrum: 5n,
        optimism: 25n,
      },
      'weighted',
      'TestStrategy',
    );

    Sinon.assert.calledOnceWithExactly(
      recordIntentCreated,
      keptRoute,
      'weighted',
    );
  });

  it('keeps routes at the min amount boundary and when token metadata is unavailable', () => {
    const routeAtMinAmount: StrategyRoute = {
      origin: 'ethereum',
      destination: 'arbitrum',
      amount: ethers.utils.parseEther('100').toBigInt(),
      executionType: 'movableCollateral',
      bridge: TEST_ADDRESSES.bridge,
    };
    const routeWithoutToken: StrategyRoute = {
      origin: 'optimism',
      destination: 'ethereum',
      amount: 25n,
      executionType: 'movableCollateral',
      bridge: TEST_ADDRESSES.bridge,
    };
    const planner = new StrategyPlanner(routeExecutionMatrix, testLogger);

    const filteredRoutes = planner.finalizeRoutes(
      [routeAtMinAmount, routeWithoutToken],
      {
        ethereum: routeAtMinAmount.amount,
        optimism: routeWithoutToken.amount,
      },
      'weighted',
      'TestStrategy',
    );

    expect(filteredRoutes).to.deep.equal([routeAtMinAmount, routeWithoutToken]);
  });
});
