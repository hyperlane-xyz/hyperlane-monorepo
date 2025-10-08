import { ethers } from 'ethers';

import { RebalancerStrategyOptions } from '@hyperlane-xyz/sdk';

import type { RebalancerConfig } from '../config/RebalancerConfig.js';
import type { IRebalancer } from '../interfaces/IRebalancer.js';
import type { RebalancingRoute } from '../interfaces/IStrategy.js';

export class MockRebalancer implements IRebalancer {
  rebalance(_routes: RebalancingRoute[]): Promise<void> {
    return Promise.resolve();
  }
}

export function buildTestConfig(
  overrides: Partial<RebalancerConfig> = {},
  chains: string[] = ['chain1'],
): RebalancerConfig {
  const baseChains = chains.reduce(
    (acc, chain) => {
      (acc as any)[chain] = {
        bridgeLockTime: 60 * 1000,
        bridge: ethers.constants.AddressZero,
        weighted: {
          weight: BigInt(1),
          tolerance: BigInt(0),
        },
      };
      return acc;
    },
    {} as Record<string, any>,
  );

  return {
    warpRouteId: 'test-route',
    strategyConfig: {
      rebalanceStrategy: RebalancerStrategyOptions.Weighted,
      chains: {
        ...baseChains,
        ...(overrides.strategyConfig?.chains ?? {}),
      },
      ...overrides.strategyConfig,
    },
    ...overrides,
  } as any as RebalancerConfig;
}
