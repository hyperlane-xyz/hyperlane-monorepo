import { ethers } from 'ethers';

import type { RebalancerConfig } from '../config/RebalancerConfig.js';
import { RebalancerStrategyOptions } from '../config/types.js';
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

  // Build the default strategy config
  const defaultStrategyConfig = {
    rebalanceStrategy: RebalancerStrategyOptions.Weighted,
    chains: baseChains,
  };

  // Merge overrides with default strategy config
  // If overrides.strategyConfig.chains is explicitly provided, use it directly (don't merge)
  const strategyConfig = overrides.strategyConfig
    ? {
        ...defaultStrategyConfig,
        ...overrides.strategyConfig,
        chains:
          (overrides.strategyConfig as any).chains !== undefined
            ? (overrides.strategyConfig as any).chains
            : baseChains,
      }
    : defaultStrategyConfig;

  // Destructure to exclude strategyConfig from overrides spread
  const { strategyConfig: _, ...restOverrides } = overrides;

  return {
    warpRouteId: 'test-route',
    ...restOverrides,
    strategyConfig,
  } as any as RebalancerConfig;
}
