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

  // If overrides has strategyConfig as an array, use it directly
  // Otherwise, wrap single strategy in an array
  let strategyConfig;
  if (overrides.strategyConfig) {
    if (Array.isArray(overrides.strategyConfig)) {
      strategyConfig = overrides.strategyConfig;
    } else {
      // Single strategy override - use it directly wrapped in array
      // If chains is explicitly provided, use it (don't merge with baseChains)
      const singleConfig = overrides.strategyConfig as any;
      strategyConfig = [
        {
          ...singleConfig,
          chains:
            singleConfig.chains !== undefined
              ? singleConfig.chains
              : baseChains,
        },
      ];
    }
  } else {
    strategyConfig = [defaultStrategyConfig];
  }

  // Destructure to exclude strategyConfig from overrides spread
  const { strategyConfig: _, ...restOverrides } = overrides;

  return {
    warpRouteId: 'test-route',
    ...restOverrides,
    strategyConfig,
  } as any as RebalancerConfig;
}
