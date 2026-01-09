import { type Logger } from 'pino';

import type { ChainMap } from '@hyperlane-xyz/sdk';
import type { Address } from '@hyperlane-xyz/utils';

import {
  RebalancerStrategyOptions,
  type WeightedStrategyConfig,
} from '../config/types.js';
import type {
  InflightContext,
  RawBalances,
  RebalancingRoute,
} from '../interfaces/IStrategy.js';
import { type Metrics } from '../metrics/Metrics.js';

import { BaseStrategy, type Delta } from './BaseStrategy.js';

/**
 * Strategy implementation that rebalance based on weights
 * It distributes funds across chains based on their weights
 */
export class WeightedStrategy extends BaseStrategy {
  readonly name = RebalancerStrategyOptions.Weighted;
  private readonly config: WeightedStrategyConfig;
  private readonly totalWeight: bigint;
  protected readonly logger: Logger;

  constructor(
    config: WeightedStrategyConfig,
    logger: Logger,
    metrics?: Metrics,
    bridges?: ChainMap<Address[]>,
  ) {
    const chains = Object.keys(config);
    const log = logger.child({ class: WeightedStrategy.name });
    super(chains, log, metrics, bridges);
    this.logger = log;

    let totalWeight = 0n;

    for (const chain of chains) {
      const { weight, tolerance } = config[chain].weighted;

      if (weight < 0n) {
        throw new Error(`Weight (${weight}) must not be negative for ${chain}`);
      }

      if (tolerance < 0n || tolerance > 100n) {
        throw new Error(
          `Tolerance (${tolerance}) must be between 0 and 100 for ${chain}`,
        );
      }

      totalWeight += weight;
    }

    if (totalWeight <= 0n) {
      throw new Error('The total weight for all chains must be greater than 0');
    }

    this.config = config;
    this.totalWeight = totalWeight;
    this.logger.info('WeightedStrategy created');
  }

  /**
   * Gets balances categorized by surplus and deficit based on weights
   *
   * If pendingRebalances are provided (from earlier strategies in a CompositeStrategy),
   * we simulate their effects on balances before calculating surpluses/deficits.
   * This prevents over-rebalancing when multiple strategies run in sequence.
   */
  protected getCategorizedBalances(
    rawBalances: RawBalances,
    pendingRebalances?: RebalancingRoute[],
  ): {
    surpluses: Delta[];
    deficits: Delta[];
  } {
    // Simulate pending rebalances to account for routes from earlier strategies
    const simulatedBalances = this.simulatePendingRebalances(
      rawBalances,
      pendingRebalances ?? [],
    );

    // Get the total balance from all chains
    const total = this.chains.reduce(
      (sum, chain) => sum + simulatedBalances[chain],
      0n,
    );

    return this.chains.reduce(
      (acc, chain) => {
        const { weight, tolerance } = this.config[chain].weighted;
        const target = (total * weight) / this.totalWeight;
        const toleranceAmount = (target * tolerance) / 100n;
        const balance = simulatedBalances[chain];

        // Apply the tolerance to deficits to prevent small imbalances
        if (balance < target - toleranceAmount) {
          acc.deficits.push({ chain, amount: target - balance });
        } else if (balance > target) {
          acc.surpluses.push({ chain, amount: balance - target });
        } else {
          // Do nothing as the balance is already on target
        }

        return acc;
      },
      {
        surpluses: [] as Delta[],
        deficits: [] as Delta[],
      },
    );
  }

  /**
   * Override getRebalancingRoutes to set bridge field on output routes.
   */
  getRebalancingRoutes(
    rawBalances: RawBalances,
    inflightContext?: InflightContext,
  ): RebalancingRoute[] {
    const routes = super.getRebalancingRoutes(rawBalances, inflightContext);

    // Set bridge field on each route using first configured bridge for the origin
    return routes.map((route) => ({
      ...route,
      bridge: this.bridges?.[route.origin]?.[0],
    }));
  }
}
