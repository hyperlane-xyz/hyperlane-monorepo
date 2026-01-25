import { Logger } from 'pino';

import { type ChainMap, type ChainName, type Token } from '@hyperlane-xyz/sdk';
import type { Address } from '@hyperlane-xyz/utils';
import { toWei } from '@hyperlane-xyz/utils';

import {
  type CollateralDeficitStrategyConfig,
  RebalancerStrategyOptions,
} from '../config/types.js';
import type {
  InflightContext,
  RawBalances,
  StrategyRoute,
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
   * 1. Filter pendingRebalances/proposedRebalances by configured bridges
   * 2. Simulate those rebalances to get projected balances
   * 3. Negative balance = deficit (magnitude + buffer)
   * 4. Positive balance = potential surplus
   */
  protected getCategorizedBalances(
    rawBalances: RawBalances,
    pendingRebalances?: StrategyRoute[],
    proposedRebalances?: StrategyRoute[],
  ): {
    surpluses: Delta[];
    deficits: Delta[];
  } {
    // Filter pending rebalances to only those using this strategy's bridges
    const filteredPending = this.filterByConfiguredBridges(pendingRebalances);
    const filteredProposed = this.filterByConfiguredBridges(proposedRebalances);

    this.logger.debug(
      {
        context: this.constructor.name,
        totalPending: pendingRebalances?.length ?? 0,
        filteredPending: filteredPending.length,
        totalProposed: proposedRebalances?.length ?? 0,
        filteredProposed: filteredProposed.length,
      },
      'Filtered rebalances by configured bridges',
    );

    // Step 1: Simulate pending rebalances (in-flight, origin already deducted on-chain)
    let simulatedBalances = this.simulatePendingRebalances(
      rawBalances,
      filteredPending,
    );

    // Step 2: Simulate proposed rebalances (from earlier strategies, not yet executed)
    simulatedBalances = this.simulateProposedRebalances(
      simulatedBalances,
      filteredProposed,
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
   * Override to prefer transfer origins when selecting surplus chains.
   *
   * When a user transfer creates a deficit, the origin chain of that transfer
   * is the natural source of funds (user deposited there). This prevents
   * unnecessarily draining the largest balance (typically ethereum at 70%).
   */
  override getRebalancingRoutes(
    rawBalances: RawBalances,
    inflightContext?: InflightContext,
  ): StrategyRoute[] {
    const pendingRebalances = inflightContext?.pendingRebalances ?? [];
    const pendingTransfers = inflightContext?.pendingTransfers ?? [];

    this.logger.info(
      {
        strategy: this.name,
        balances: Object.entries(rawBalances).map(([c, b]) => ({
          chain: c,
          balance: b.toString(),
        })),
        pendingRebalances: pendingRebalances.length,
        pendingTransfers: pendingTransfers.length,
      },
      'Strategy evaluating',
    );
    this.validateRawBalances(rawBalances);

    const actualBalances = rawBalances;

    // Step 1: Reserve collateral for pending user transfers
    const effectiveBalances = this.reserveCollateral(
      rawBalances,
      pendingTransfers,
    );

    // Step 2: Get categorized balances
    const { surpluses, deficits } = this.getCategorizedBalances(
      effectiveBalances,
      pendingRebalances,
    );

    this.logger.debug(
      { context: this.constructor.name, surpluses },
      'Surpluses calculated',
    );
    this.logger.debug(
      { context: this.constructor.name, deficits },
      'Deficits calculated',
    );

    const totalSurplus = surpluses.reduce((sum, s) => sum + s.amount, 0n);
    const totalDeficit = deficits.reduce((sum, d) => sum + d.amount, 0n);

    this.logger.debug(
      { context: this.constructor.name, totalSurplus: totalSurplus.toString() },
      'Total surplus calculated',
    );
    this.logger.debug(
      { context: this.constructor.name, totalDeficit: totalDeficit.toString() },
      'Total deficit calculated',
    );

    // Scale deficits if needed
    if (totalSurplus < totalDeficit) {
      this.logger.warn(
        {
          context: this.constructor.name,
          totalSurplus: totalSurplus.toString(),
          totalDeficit: totalDeficit.toString(),
        },
        'Deficits are greater than surpluses. Scaling deficits',
      );
      this.metrics?.recordRebalancerFailure();
      for (const deficit of deficits) {
        deficit.amount = (deficit.amount * totalSurplus) / totalDeficit;
      }
      this.logger.debug(
        { context: this.constructor.name, deficits },
        'Scaled deficits',
      );
    }

    // Build transfer origin map for deficit chains
    const deficitChains = new Set(deficits.map((d) => d.chain));
    const transferOriginMap = this.buildTransferOriginMap(
      pendingTransfers,
      deficitChains,
    );

    // Sort surpluses with transfer origin preference (KEY CHANGE from base class)
    this.sortSurplusesWithOriginPreference(surpluses, transferOriginMap);

    // Sort deficits by amount (largest first)
    deficits.sort((a, b) => (a.amount > b.amount ? -1 : 1));

    const routes: StrategyRoute[] = [];

    // Match surpluses to deficits
    while (deficits.length > 0 && surpluses.length > 0) {
      const surplus = surpluses[0];
      const deficit = deficits[0];
      const transferAmount =
        surplus.amount > deficit.amount ? deficit.amount : surplus.amount;

      if (transferAmount > 0n) {
        routes.push({
          origin: surplus.chain,
          destination: deficit.chain,
          amount: transferAmount,
          bridge: this.bridges?.[surplus.chain]?.[0],
        });
      }

      deficit.amount -= transferAmount;
      surplus.amount -= transferAmount;

      if (deficit.amount <= 0n) deficits.shift();
      if (surplus.amount <= 0n) surpluses.shift();
    }

    this.logger.debug(
      { context: this.constructor.name, routes },
      'Generated routes',
    );
    this.logger.info(
      { context: this.constructor.name, numberOfRoutes: routes.length },
      'Found rebalancing routes',
    );

    const filteredRoutes = this.filterRebalances(routes, actualBalances);

    this.logger.debug(
      {
        context: this.constructor.name,
        filteredRoutesCount: filteredRoutes.length,
        droppedCount: routes.length - filteredRoutes.length,
      },
      'Filtered rebalancing routes',
    );

    return filteredRoutes;
  }

  /**
   * Filter pending rebalances to only those using this strategy's configured bridges.
   * A rebalance matches if:
   * - Its bridge is in the origin chain's configured bridges, OR
   * - It has no bridge (recovered from Explorer, can't verify - include to be safe)
   */
  private filterByConfiguredBridges(
    pendingRebalances?: StrategyRoute[],
  ): StrategyRoute[] {
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

  /**
   * Build a map from deficit chains to their transfer origin chains.
   * This identifies which surplus chains are "natural" sources for each deficit.
   */
  private buildTransferOriginMap(
    pendingTransfers: StrategyRoute[],
    deficitChains: Set<ChainName>,
  ): Map<ChainName, Set<ChainName>> {
    const originMap = new Map<ChainName, Set<ChainName>>();

    for (const transfer of pendingTransfers) {
      // Only track transfers TO deficit chains
      if (deficitChains.has(transfer.destination)) {
        if (!originMap.has(transfer.destination)) {
          originMap.set(transfer.destination, new Set());
        }
        originMap.get(transfer.destination)!.add(transfer.origin);
      }
    }

    return originMap;
  }

  /**
   * Sort surpluses to prefer transfer origins over largest balances.
   *
   * Sorting priority:
   * 1. Chains that are origins of transfers TO any deficit chain (preferred)
   * 2. By amount descending (tiebreaker)
   */
  private sortSurplusesWithOriginPreference(
    surpluses: Delta[],
    transferOriginMap: Map<ChainName, Set<ChainName>>,
  ): void {
    // Collect all origin chains across all deficits
    const allOriginChains = new Set<ChainName>();
    for (const origins of transferOriginMap.values()) {
      for (const origin of origins) {
        allOriginChains.add(origin);
      }
    }

    surpluses.sort((a, b) => {
      const aIsOrigin = allOriginChains.has(a.chain);
      const bIsOrigin = allOriginChains.has(b.chain);

      // Prefer transfer origins
      if (aIsOrigin && !bIsOrigin) return -1;
      if (!aIsOrigin && bIsOrigin) return 1;

      // Tiebreaker: larger amount first
      return a.amount > b.amount ? -1 : 1;
    });

    if (allOriginChains.size > 0) {
      this.logger.debug(
        {
          context: this.constructor.name,
          preferredOrigins: Array.from(allOriginChains),
          sortedSurpluses: surpluses.map((s) => s.chain),
        },
        'Sorted surpluses with transfer origin preference',
      );
    }
  }

  protected getTokenByChainName(chainName: string): Token {
    const token = this.tokensByChainName[chainName];
    if (token === undefined) {
      throw new Error(`Token not found for chain ${chainName}`);
    }
    return token;
  }
}
