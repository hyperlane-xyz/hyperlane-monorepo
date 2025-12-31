import { ethers } from 'ethers';

import type { RebalancerConfig } from '../config/RebalancerConfig.js';
import { RebalancerStrategyOptions, type WeightedStrategy } from '../config/types.js';
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
      acc[chain] = {
        bridgeLockTime: 60 * 1000,
        bridge: ethers.constants.AddressZero,
        weighted: {
          weight: BigInt(1),
          tolerance: BigInt(0),
        },
      };
      return acc;
    },
    {} as WeightedStrategy['chains'],
  );

  // Cast override strategyConfig to WeightedStrategy for type safety
  const overrideStrategy = overrides.strategyConfig as
    | WeightedStrategy
    | undefined;

  return {
    warpRouteId: 'test-route',
    strategyConfig: {
      rebalanceStrategy: RebalancerStrategyOptions.Weighted,
      chains: {
        ...baseChains,
        ...(overrideStrategy?.chains ?? {}),
      },
      ...overrideStrategy,
    },
    ...overrides,
  } as RebalancerConfig;
}
