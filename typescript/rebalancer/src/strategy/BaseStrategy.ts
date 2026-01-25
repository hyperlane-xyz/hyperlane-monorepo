import { type Logger } from 'pino';

import type { ChainMap, ChainName } from '@hyperlane-xyz/sdk';
import type { Address } from '@hyperlane-xyz/utils';

import type {
  IStrategy,
  InflightContext,
  RawBalances,
  StrategyRoute,
} from '../interfaces/IStrategy.js';
import { type Metrics } from '../metrics/Metrics.js';

export type Delta = { chain: ChainName; amount: bigint };

/**
 * Base abstract class for rebalancing strategies
 */
export abstract class BaseStrategy implements IStrategy {
  abstract readonly name: string;
  protected readonly chains: ChainName[];
  protected readonly metrics?: Metrics;
  protected readonly logger: Logger;
  protected readonly bridges?: ChainMap<Address[]>;

  constructor(
    chains: ChainName[],
    logger: Logger,
    metrics?: Metrics,
    bridges?: ChainMap<Address[]>,
  ) {
    // Rebalancing makes sense only with more than one chain.
    if (chains.length < 2) {
      throw new Error('At least two chains must be configured');
    }
    this.chains = chains;
    this.logger = logger;
    this.metrics = metrics;
    this.bridges = bridges;
  }

  /**
   * Main method to get rebalancing routes
   */
  getRebalancingRoutes(
    rawBalances: RawBalances,
    inflightContext?: InflightContext,
  ): StrategyRoute[] {
    const pendingRebalances = inflightContext?.pendingRebalances ?? [];
    const pendingTransfers = inflightContext?.pendingTransfers ?? [];
    const proposedRebalances = inflightContext?.proposedRebalances ?? [];

    this.logger.info(
      {
        strategy: this.name,
        balances: Object.entries(rawBalances).map(([c, b]) => ({
          chain: c,
          balance: b.toString(),
        })),
        pendingRebalances: pendingRebalances.length,
        pendingTransfers: pendingTransfers.length,
        proposedRebalances: proposedRebalances.length,
      },
      'Strategy evaluating',
    );
    this.validateRawBalances(rawBalances);

    // Store original balances for filtering step
    const actualBalances = rawBalances;

    // Step 1: Reserve collateral for pending user transfers
    // This prevents draining collateral needed for incoming user transfers
    const effectiveBalances = this.reserveCollateral(
      rawBalances,
      pendingTransfers,
    );

    // Get balances categorized by surplus and deficit
    // Pass pending and proposed rebalances so strategy can account for them
    const { surpluses, deficits } = this.getCategorizedBalances(
      effectiveBalances,
      pendingRebalances,
      proposedRebalances,
    );

    this.logger.debug(
      {
        context: this.constructor.name,
        surpluses,
      },
      'Surpluses calculated',
    );
    this.logger.debug(
      {
        context: this.constructor.name,
        deficits,
      },
      'Deficits calculated',
    );

    // Calculate sums of surpluses and deficits
    const totalSurplus = surpluses.reduce(
      (sum, surplus) => sum + surplus.amount,
      0n,
    );
    const totalDeficit = deficits.reduce(
      (sum, deficit) => sum + deficit.amount,
      0n,
    );

    this.logger.debug(
      {
        context: this.constructor.name,
        totalSurplus: totalSurplus.toString(),
      },
      'Total surplus calculated',
    );
    this.logger.debug(
      {
        context: this.constructor.name,
        totalDeficit: totalDeficit.toString(),
      },
      'Total deficit calculated',
    );

    // If total surplus is less than total deficit, scale down deficits proportionally
    if (totalSurplus < totalDeficit) {
      this.logger.warn(
        {
          context: this.constructor.name,
          totalSurplus: totalSurplus.toString(),
          totalDeficit: totalDeficit.toString(),
        },
        'Deficits are greater than surpluses. Scaling deficits',
      );

      // we consider this a failure because we cannot rebalance the route completely
      // however we can still transfer some amount of the deficit to reduce the imbalances
      this.metrics?.recordRebalancerFailure();

      for (const deficit of deficits) {
        const newAmount = (deficit.amount * totalSurplus) / totalDeficit;

        deficit.amount = newAmount;
      }

      this.logger.debug(
        {
          context: this.constructor.name,
          deficits,
        },
        'Scaled deficits',
      );
    }

    // Sort from largest to smallest amounts as to always transfer largest amounts
    // first and decrease the amount of routes required
    surpluses.sort((a, b) => (a.amount > b.amount ? -1 : 1));
    deficits.sort((a, b) => (a.amount > b.amount ? -1 : 1));

    const routes: StrategyRoute[] = [];

    // Transfer from surplus to deficit until all deficits are balanced.
    while (deficits.length > 0 && surpluses.length > 0) {
      const surplus = surpluses[0];
      const deficit = deficits[0];

      // Transfers the whole surplus or just the amount to balance the deficit
      const transferAmount =
        surplus.amount > deficit.amount ? deficit.amount : surplus.amount;

      // Skip zero-amount routes (can occur after scaling when surpluses < deficits)
      if (transferAmount > 0n) {
        // Creates the balancing route
        routes.push({
          origin: surplus.chain,
          destination: deficit.chain,
          amount: transferAmount,
          bridge: this.bridges?.[surplus.chain]?.[0],
        });
      }

      // Decreases the amounts for the following iterations
      deficit.amount -= transferAmount;
      surplus.amount -= transferAmount;

      // Removes the deficit if it is fully balanced (including scaled-to-zero)
      if (deficit.amount <= 0n) {
        deficits.shift();
      }

      // Removes the surplus if it has been drained
      if (surplus.amount <= 0n) {
        surpluses.shift();
      }
    }

    this.logger.debug(
      {
        context: this.constructor.name,
        routes,
      },
      'Generated routes',
    );
    this.logger.info(
      {
        context: this.constructor.name,
        numberOfRoutes: routes.length,
      },
      'Found rebalancing routes',
    );

    // Record metrics for each intent created
    for (const route of routes) {
      this.metrics?.recordIntentCreated(route, this.name);
    }

    // Filter routes based on actual balance sufficiency
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
   * Abstract method to get balances categorized by surplus and deficit
   * Each specific strategy should implement its own logic
   *
   * @param balances - Effective balances (after collateral reservation)
   * @param pendingRebalances - In-flight rebalances (origin tx confirmed, balance already deducted)
   * @param proposedRebalances - Routes from earlier strategies in same cycle (not yet executed)
   * @returns Categorized surpluses and deficits as Delta arrays
   */
  protected abstract getCategorizedBalances(
    balances: RawBalances,
    pendingRebalances?: StrategyRoute[],
    proposedRebalances?: StrategyRoute[],
  ): {
    surpluses: Delta[];
    deficits: Delta[];
  };

  /**
   * Validates the raw balances against the chains configuration
   */
  protected validateRawBalances(rawBalances: RawBalances): void {
    const rawBalancesChains = Object.keys(rawBalances);

    if (this.chains.length !== rawBalancesChains.length) {
      throw new Error('Config chains do not match raw balances chains length');
    }

    for (const chain of this.chains) {
      const balance: bigint | undefined = rawBalances[chain];

      if (balance === undefined) {
        throw new Error(`Raw balance for chain ${chain} not found`);
      }

      if (balance < 0n) {
        throw new Error(`Raw balance for chain ${chain} is negative`);
      }
    }
  }

  /**
   * Reserve collateral for pending user transfers.
   * Subtracts pending transfer amounts from destination balances.
   * This ensures we don't drain collateral needed for incoming transfers.
   *
   * @param rawBalances - Current on-chain balances
   * @param pendingTransfers - Transfers that will need collateral on destination
   * @returns Balances with reserved amounts subtracted
   */
  protected reserveCollateral(
    rawBalances: RawBalances,
    pendingTransfers: StrategyRoute[],
  ): RawBalances {
    if (pendingTransfers.length === 0) {
      return rawBalances;
    }

    const reserved = { ...rawBalances };

    for (const transfer of pendingTransfers) {
      const destBalance = reserved[transfer.destination] ?? 0n;
      // Reserve the transfer amount from destination
      // Allow negative values to indicate collateral deficits
      reserved[transfer.destination] = destBalance - transfer.amount;

      this.logger.debug(
        {
          context: this.constructor.name,
          destination: transfer.destination,
          amount: transfer.amount.toString(),
          newBalance: reserved[transfer.destination].toString(),
        },
        'Reserved collateral for pending transfer',
      );
    }

    this.logger.info(
      {
        reservations: pendingTransfers.map((t) => ({
          destination: t.destination,
          amount: t.amount.toString(),
        })),
      },
      'Collateral reserved for pending transfers',
    );

    return reserved;
  }

  /**
   * Simulate pending rebalances by adding to destination balances.
   *
   * Only adds to destination - does NOT subtract from origin because:
   * - pendingRebalances only contains in_progress intents (origin tx confirmed)
   * - Origin balance is already deducted on-chain
   *
   * @param rawBalances - Current balances (may already have collateral reserved)
   * @param pendingRebalances - In-flight rebalance operations (in_progress only)
   * @returns Simulated future balances after rebalances complete
   */
  protected simulatePendingRebalances(
    rawBalances: RawBalances,
    pendingRebalances: StrategyRoute[],
  ): RawBalances {
    if (pendingRebalances.length === 0) {
      return rawBalances;
    }

    const simulated = { ...rawBalances };

    for (const rebalance of pendingRebalances) {
      // Only add to destination - origin is already deducted on-chain
      // (pendingRebalances only contains in_progress intents with confirmed origin tx)
      simulated[rebalance.destination] =
        (simulated[rebalance.destination] ?? 0n) + rebalance.amount;

      this.logger.debug(
        {
          context: this.constructor.name,
          destination: rebalance.destination,
          amount: rebalance.amount.toString(),
        },
        'Simulated pending rebalance (destination increase)',
      );
    }

    this.logger.info(
      {
        simulations: pendingRebalances.map((r) => ({
          from: r.origin,
          to: r.destination,
          amount: r.amount.toString(),
        })),
      },
      'Simulated pending rebalances',
    );

    return simulated;
  }

  /**
   * Simulate proposed rebalances by subtracting from origin AND adding to destination.
   *
   * Unlike pendingRebalances, proposedRebalances are routes from earlier strategies
   * in the same cycle that haven't been executed yet. Therefore:
   * - Origin balance has NOT been deducted on-chain
   * - We must simulate both sides to maintain accurate total balance
   *
   * @param rawBalances - Current balances (may already have pending rebalances simulated)
   * @param proposedRebalances - Routes from earlier strategies (not yet executed)
   * @returns Simulated balances after proposed rebalances complete
   */
  protected simulateProposedRebalances(
    rawBalances: RawBalances,
    proposedRebalances: StrategyRoute[],
  ): RawBalances {
    if (proposedRebalances.length === 0) {
      return rawBalances;
    }

    const simulated = { ...rawBalances };

    for (const rebalance of proposedRebalances) {
      // Subtract from origin (not yet deducted on-chain)
      simulated[rebalance.origin] =
        (simulated[rebalance.origin] ?? 0n) - rebalance.amount;

      // Add to destination
      simulated[rebalance.destination] =
        (simulated[rebalance.destination] ?? 0n) + rebalance.amount;

      this.logger.debug(
        {
          context: this.constructor.name,
          origin: rebalance.origin,
          destination: rebalance.destination,
          amount: rebalance.amount.toString(),
        },
        'Simulated proposed rebalance (origin decrease, destination increase)',
      );
    }

    this.logger.info(
      {
        simulations: proposedRebalances.map((r) => ({
          from: r.origin,
          to: r.destination,
          amount: r.amount.toString(),
        })),
      },
      'Simulated proposed rebalances',
    );

    return simulated;
  }

  /**
   * Filter rebalances based on actual balance sufficiency.
   * Removes routes where the origin router doesn't have enough balance.
   *
   * Concrete strategies can override this method to implement different
   * filtering logic (e.g., all-or-nothing for weighted strategy).
   *
   * @param routes - Proposed rebalancing routes
   * @param actualBalances - Actual on-chain balances
   * @returns Filtered routes that can actually be executed
   */
  protected filterRebalances(
    routes: StrategyRoute[],
    actualBalances: RawBalances,
  ): StrategyRoute[] {
    return routes.filter((route) => {
      const balance = actualBalances[route.origin] ?? 0n;
      const hasSufficientBalance = balance >= route.amount;

      if (!hasSufficientBalance) {
        this.logger.warn(
          {
            context: this.constructor.name,
            origin: route.origin,
            destination: route.destination,
            required: route.amount.toString(),
            available: balance.toString(),
          },
          'Dropping route due to insufficient balance',
        );
      }

      return hasSufficientBalance;
    });
  }
}
