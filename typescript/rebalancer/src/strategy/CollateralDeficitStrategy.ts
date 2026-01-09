import { Logger } from 'pino';

import { type ChainMap, type Token } from '@hyperlane-xyz/sdk';
import type { Address } from '@hyperlane-xyz/utils';
import { toWei } from '@hyperlane-xyz/utils';

import {
  type CollateralDeficitStrategyConfig,
  RebalancerStrategyOptions,
} from '../config/types.js';
import type {
  InflightContext,
  RawBalances,
  RebalancingRoute,
} from '../interfaces/IStrategy.js';
import { Metrics } from '../metrics/Metrics.js';

import { BaseStrategy, type Delta } from './BaseStrategy.js';

/**
 * Strategy that detects collateral deficits (negative effective balances)
 * and proposes JIT rebalances using fast bridges.
 *
 * Logic:
 * 1. Filter pendingRebalances to only those using this strategy's configured bridges
 * 2. Simulate filtered pending rebalances to get projected balances
 * 3. Negative simulated balance = deficit (magnitude + buffer)
 * 4. Positive simulated balance = potential surplus
 */
export class CollateralDeficitStrategy extends BaseStrategy {
  readonly name = RebalancerStrategyOptions.CollateralDeficit;
  private readonly config: CollateralDeficitStrategyConfig;
  protected readonly logger: Logger;

  constructor(
    config: CollateralDeficitStrategyConfig,
    private readonly tokensByChainName: ChainMap<Token>,
    logger: Logger,
    metrics?: Metrics,
    bridges?: ChainMap<Address[]>,
  ) {
    const chains = Object.keys(config);
    const log = logger.child({ class: CollateralDeficitStrategy.name });
    super(chains, log, metrics, bridges);
    this.logger = log;
    this.config = config;
    this.logger.info('CollateralDeficitStrategy created');
  }

  /**
   * Categorizes balances into surpluses and deficits.
   *
   * 1. Filter pendingRebalances by configured bridges
   * 2. Simulate those rebalances to get projected balances
   * 3. Negative balance = deficit (magnitude + buffer)
   * 4. Positive balance = potential surplus
   */
  protected getCategorizedBalances(
    rawBalances: RawBalances,
    pendingRebalances?: RebalancingRoute[],
  ): {
    surpluses: Delta[];
    deficits: Delta[];
  } {
    // Filter pending rebalances to only those using this strategy's bridges
    const filteredRebalances =
      this.filterByConfiguredBridges(pendingRebalances);

    this.logger.debug(
      {
        context: this.constructor.name,
        totalPending: pendingRebalances?.length ?? 0,
        filteredPending: filteredRebalances.length,
      },
      'Filtered pending rebalances by configured bridges',
    );

    // Simulate filtered rebalances to get projected balances
    const simulatedBalances = this.simulatePendingRebalances(
      rawBalances,
      filteredRebalances,
    );

    const surpluses: Delta[] = [];
    const deficits: Delta[] = [];

    for (const chain of this.chains) {
      const balance = simulatedBalances[chain];
      const token = this.getTokenByChainName(chain);
      const bufferWei = BigInt(
        toWei(this.config[chain].buffer, token.decimals),
      );

      if (balance < 0n) {
        // Negative balance indicates deficit
        const deficitAmount = -balance + bufferWei;
        deficits.push({ chain, amount: deficitAmount });

        this.logger.debug(
          {
            context: this.constructor.name,
            chain,
            simulatedBalance: balance.toString(),
            buffer: bufferWei.toString(),
            deficitAmount: deficitAmount.toString(),
          },
          'Detected collateral deficit',
        );
      } else if (balance > 0n) {
        // Positive balance is potential surplus
        surpluses.push({ chain, amount: balance });
      }
    }

    this.logger.info(
      {
        surpluses: surpluses.map((s) => ({
          chain: s.chain,
          amount: s.amount.toString(),
        })),
        deficits: deficits.map((d) => ({
          chain: d.chain,
          amount: d.amount.toString(),
        })),
      },
      'Balance categorization',
    );

    return { surpluses, deficits };
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

  /**
   * Filter pending rebalances to only those using this strategy's configured bridges.
   * A rebalance matches if:
   * - Its bridge is in the origin chain's configured bridges, OR
   * - It has no bridge (recovered from Explorer, can't verify - include to be safe)
   */
  private filterByConfiguredBridges(
    pendingRebalances?: RebalancingRoute[],
  ): RebalancingRoute[] {
    if (!pendingRebalances || pendingRebalances.length === 0) {
      return [];
    }

    return pendingRebalances.filter((rebalance) => {
      // Include routes without bridge (recovered from Explorer, can't verify)
      if (!rebalance.bridge) {
        this.logger.debug(
          { origin: rebalance.origin, destination: rebalance.destination },
          'Including pending rebalance without bridge (recovered intent)',
        );
        return true;
      }
      // For routes with bridge, verify it's configured
      const configuredBridges = this.bridges?.[rebalance.origin] ?? [];
      return configuredBridges.includes(rebalance.bridge);
    });
  }

  protected getTokenByChainName(chainName: string): Token {
    const token = this.tokensByChainName[chainName];
    if (token === undefined) {
      throw new Error(`Token not found for chain ${chainName}`);
    }
    return token;
  }
}
