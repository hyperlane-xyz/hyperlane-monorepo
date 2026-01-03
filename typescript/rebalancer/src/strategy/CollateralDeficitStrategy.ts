import { Logger } from 'pino';

import type { ChainMap, ChainName } from '@hyperlane-xyz/sdk';

import type { RawBalances, RebalancingRoute } from '../interfaces/IStrategy.js';
import { Metrics } from '../metrics/Metrics.js';

import { BaseStrategy, type Delta } from './BaseStrategy.js';

/**
 * Configuration for a chain in the CollateralDeficit strategy
 */
export type CollateralDeficitChainConfig = {
  /** Bridge address for just-in-time rebalances (e.g., CCTP V2 Fast) */
  bridge: string;
  /** Buffer amount to add to deficit for headroom (in wei) */
  buffer: bigint;
};

export type CollateralDeficitStrategyConfig =
  ChainMap<CollateralDeficitChainConfig>;

/**
 * Strategy implementation that detects and addresses collateral deficits.
 *
 * This strategy interprets negative balances (after collateral reservation)
 * as deficits that need immediate attention via just-in-time rebalancing.
 *
 * Key behaviors:
 * - Scans for negative balances indicating insufficient collateral
 * - Adds a configurable buffer per chain for headroom
 * - Checks pending rebalances using the same bridge to avoid duplicates
 * - Uses fast bridges (e.g., CCTP V2 Fast) for quick delivery
 */
export class CollateralDeficitStrategy extends BaseStrategy {
  private readonly config: CollateralDeficitStrategyConfig;
  protected readonly logger: Logger;

  constructor(
    config: CollateralDeficitStrategyConfig,
    logger: Logger,
    metrics?: Metrics,
  ) {
    const chains = Object.keys(config);
    const log = logger.child({ class: CollateralDeficitStrategy.name });
    super(chains, log, metrics);
    this.logger = log;
    this.config = config;

    // Validate config
    for (const chain of chains) {
      const chainConfig = config[chain];

      if (!chainConfig.bridge) {
        throw new Error(`Bridge address required for chain ${chain}`);
      }

      if (chainConfig.buffer < 0n) {
        throw new Error(`Buffer cannot be negative for chain ${chain}`);
      }
    }

    this.logger.info('CollateralDeficitStrategy created');
  }

  /**
   * Override validation to allow negative balances.
   * This strategy is designed to detect deficits (negative balances after
   * collateral reservation), so negative values are expected and valid.
   */
  protected override validateRawBalances(
    rawBalances: RawBalances,
    _allowNegative = true,
  ): void {
    // Always allow negative balances for deficit detection
    super.validateRawBalances(rawBalances, true);
  }

  /**
   * Override to only fast-forward pending rebalances that use the same bridge
   * as this strategy. This ensures we still detect deficits even if there are
   * pending rebalances via slower bridges - we want to send fast bridge
   * rebalances regardless.
   */
  protected override simulatePendingRebalances(
    rawBalances: RawBalances,
    pendingRebalances: RebalancingRoute[],
  ): RawBalances {
    // Filter to only same-bridge rebalances
    const sameBridgeRebalances = pendingRebalances.filter((rebalance) => {
      const chainConfig = this.config[rebalance.destination];
      return chainConfig && rebalance.bridge === chainConfig.bridge;
    });

    return super.simulatePendingRebalances(rawBalances, sameBridgeRebalances);
  }

  /**
   * Gets balances categorized by surplus and deficit.
   *
   * This strategy treats negative balances as deficits (after collateral
   * reservation from BaseStrategy). The deficit amount is the absolute value
   * of the negative balance plus the configured buffer.
   *
   * @param rawBalances Adjusted balances (may be negative after reservation)
   * @param pendingRebalances Pending rebalances to check for conflicts
   */
  protected getCategorizedBalances(
    rawBalances: RawBalances,
    pendingRebalances: RebalancingRoute[],
  ): {
    surpluses: Delta[];
    deficits: Delta[];
  } {
    const surpluses: Delta[] = [];
    const deficits: Delta[] = [];

    // Create a map of pending rebalances by destination using same bridge
    const pendingByDest = this.getPendingByDestination(pendingRebalances);

    for (const chain of this.chains) {
      const balance = rawBalances[chain];
      const chainConfig = this.config[chain];

      if (balance < 0n) {
        // Negative balance indicates a deficit
        // Deficit amount = abs(negative balance) + buffer
        const deficitAmount = -balance + chainConfig.buffer;

        // Check if there's already a pending rebalance to this chain
        // using the same bridge that would satisfy the deficit
        const pendingAmount = pendingByDest.get(chain) ?? 0n;

        if (pendingAmount >= deficitAmount) {
          this.logger.debug(
            {
              chain,
              deficitAmount: deficitAmount.toString(),
              pendingAmount: pendingAmount.toString(),
            },
            'Deficit already covered by pending rebalance',
          );
          continue;
        }

        // Calculate remaining deficit after accounting for pending
        const remainingDeficit = deficitAmount - pendingAmount;

        if (remainingDeficit > 0n) {
          deficits.push({ chain, amount: remainingDeficit });

          this.logger.info(
            {
              chain,
              balance: balance.toString(),
              buffer: chainConfig.buffer.toString(),
              deficitAmount: deficitAmount.toString(),
              pendingAmount: pendingAmount.toString(),
              remainingDeficit: remainingDeficit.toString(),
            },
            'Detected collateral deficit',
          );
        }
      } else if (balance > 0n) {
        // Positive balance can contribute to surplus
        surpluses.push({ chain, amount: balance });
      }
    }

    return { surpluses, deficits };
  }

  /**
   * Get a map of pending rebalance amounts by destination,
   * only counting rebalances using bridges configured for this strategy.
   */
  private getPendingByDestination(
    pendingRebalances: RebalancingRoute[],
  ): Map<ChainName, bigint> {
    const pendingByDest = new Map<ChainName, bigint>();

    for (const rebalance of pendingRebalances) {
      const chainConfig = this.config[rebalance.destination];

      // Only count rebalances using the same bridge as this strategy
      if (chainConfig && rebalance.bridge === chainConfig.bridge) {
        const current = pendingByDest.get(rebalance.destination) ?? 0n;
        pendingByDest.set(rebalance.destination, current + rebalance.amount);
      }
    }

    return pendingByDest;
  }

  /**
   * Override to assign the bridge for each route based on destination chain.
   */
  getRebalancingRoutes(
    rawBalances: RawBalances,
    inflightContext?: {
      pendingTransfers: RebalancingRoute[];
      pendingRebalances: RebalancingRoute[];
    },
  ): RebalancingRoute[] {
    // Get routes from base implementation
    const routes = super.getRebalancingRoutes(rawBalances, inflightContext);

    // Assign bridge based on destination chain config
    return routes.map((route) => ({
      ...route,
      bridge: this.config[route.destination]?.bridge,
    }));
  }
}
