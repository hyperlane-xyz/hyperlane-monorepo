import { expect } from 'chai';

import { ExternalBridgeType } from '../config/types.js';
import type { RouteExecutionMatrix } from '../utils/bridgeUtils.js';

import { materializeStrategyRoute, planRoutes } from './RoutePlanner.js';

describe('RoutePlanner', () => {
  const routeExecutionMatrix: RouteExecutionMatrix = {
    ethereum: {
      arbitrum: {
        executionType: 'movableCollateral',
        bridge: '0x1111111111111111111111111111111111111111',
      },
      optimism: {
        executionType: 'inventory',
        externalBridge: ExternalBridgeType.LiFi,
      },
    },
    arbitrum: {
      ethereum: {
        executionType: 'movableCollateral',
        bridge: '0x2222222222222222222222222222222222222222',
      },
      optimism: {
        executionType: 'movableCollateral',
        bridge: '0x3333333333333333333333333333333333333333',
      },
    },
    optimism: {
      ethereum: {
        executionType: 'movableCollateral',
        bridge: '0x4444444444444444444444444444444444444444',
      },
      arbitrum: {
        executionType: 'movableCollateral',
        bridge: '0x5555555555555555555555555555555555555555',
      },
    },
  };

  it('materializes movable collateral routes from the matrix', () => {
    const route = materializeStrategyRoute(
      routeExecutionMatrix,
      'ethereum',
      'arbitrum',
      10n,
    );

    expect(route).to.deep.equal({
      origin: 'ethereum',
      destination: 'arbitrum',
      amount: 10n,
      executionType: 'movableCollateral',
      bridge: '0x1111111111111111111111111111111111111111',
    });
  });

  it('materializes inventory routes from the matrix', () => {
    const route = materializeStrategyRoute(
      routeExecutionMatrix,
      'ethereum',
      'optimism',
      10n,
    );

    expect(route).to.deep.equal({
      origin: 'ethereum',
      destination: 'optimism',
      amount: 10n,
      executionType: 'inventory',
      externalBridge: ExternalBridgeType.LiFi,
    });
  });

  it('matches surpluses to deficits in order', () => {
    const routes = planRoutes(
      [
        { chain: 'ethereum', amount: 100n },
        { chain: 'arbitrum', amount: 50n },
      ],
      [{ chain: 'optimism', amount: 120n }],
      routeExecutionMatrix,
    );

    expect(routes).to.deep.equal([
      {
        origin: 'ethereum',
        destination: 'optimism',
        amount: 100n,
        executionType: 'inventory',
        externalBridge: ExternalBridgeType.LiFi,
      },
      {
        origin: 'arbitrum',
        destination: 'optimism',
        amount: 20n,
        executionType: 'movableCollateral',
        bridge: '0x3333333333333333333333333333333333333333',
      },
    ]);
  });

  it('skips zero-amount routes while draining exhausted deltas', () => {
    const routes = planRoutes(
      [
        { chain: 'ethereum', amount: 0n },
        { chain: 'arbitrum', amount: 50n },
      ],
      [
        { chain: 'optimism', amount: 0n },
        { chain: 'ethereum', amount: 30n },
      ],
      routeExecutionMatrix,
    );

    expect(routes).to.deep.equal([
      {
        origin: 'arbitrum',
        destination: 'ethereum',
        amount: 30n,
        executionType: 'movableCollateral',
        bridge: '0x2222222222222222222222222222222222222222',
      },
    ]);
  });
});
