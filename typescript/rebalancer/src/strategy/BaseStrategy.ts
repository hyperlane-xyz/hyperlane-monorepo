import { type Logger } from 'pino';

import type { ChainMap, ChainName, Token } from '@hyperlane-xyz/sdk';
import { toWei } from '@hyperlane-xyz/utils';

import type {
  IStrategy,
  InflightContext,
  RawBalances,
  Route,
  StrategyRoute,
} from '../interfaces/IStrategy.js';
import { type Metrics } from '../metrics/Metrics.js';
import {
  type BridgeConfig,
  type BridgeConfigWithOverride,
  getBridgeConfig,
} from '../utils/bridgeUtils.js';

export type Delta = { chain: ChainName; amount: bigint };

/**
 * Base abstract class for rebalancing strategies
 */
export abstract class BaseStrategy implements IStrategy {
  abstract readonly name: string;
  protected readonly chains: ChainName[];
  protected readonly metrics?: Metrics;
  protected readonly logger: Logger;
  protected readonly bridgeConfigs: ChainMap<BridgeConfigWithOverride>;
  protected readonly tokensByChainName?: ChainMap<Token>;

  constructor(
    chains: ChainName[],
    logger: Logger,
    bridgeConfigs: ChainMap<BridgeConfigWithOverride>,
    metrics?: Metrics,
    tokensByChainName?: ChainMap<Token>,
  ) {
    // Rebalancing makes sense only with more than one chain.
    if (chains.length < 2) {
      throw new Error('At least two chains must be configured');
    }
    this.chains = chains;
    this.logger = logger;
    this.bridgeConfigs = bridgeConfigs;
    this.metrics = metrics;
    this.tokensByChainName = tokensByChainName;
  }

  protected getBridgeConfigForRoute(
    origin: ChainName,
    destination: ChainName,
  ): BridgeConfig {
    return getBridgeConfig(this.bridgeConfigs, origin, destination);
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
        // Get bridge config for this route (with destination-specific overrides)
        const bridgeConfig = this.getBridgeConfigForRoute(
          surplus.chain,
          deficit.chain,
        );

        // Creates the balancing route
        routes.push({
          origin: surplus.chain,
          destination: deficit.chain,
          amount: transferAmount,
          bridge: bridgeConfig.bridge,
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

    const filteredRoutes = this.filterRoutes(routes, actualBalances);

    this.logger.debug(
      {
        context: this.constructor.name,
        filteredRoutesCount: filteredRoutes.length,
        droppedCount: routes.length - filteredRoutes.length,
      },
      'Filtered rebalancing routes',
    );

    // Record metrics for each intent that passed filtering
    for (const route of filteredRoutes) {
      this.metrics?.recordIntentCreated(route, this.name);
    }

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
    pendingRebalances?: Route[],
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
    pendingTransfers: Route[],
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
   * Simulate pending rebalances based on execution method.
   *
   * For **movable_collateral** (default):
   * - Add full amount to destination (origin already deducted on-chain)
   *
   * For **inventory**:
   * - Simulate the eventual final state as if the entire intent will be fulfilled
   * - Destination: add unfulfilled amount (total - delivered - awaiting)
   *   This is what's NOT yet reflected in on-chain balance
   * - Origin: subtract pending amount (total - delivered)
   *   This is what WILL decrease when all messages deliver
   *
   * @param rawBalances - Current balances (may already have collateral reserved)
   * @param pendingRebalances - In-flight rebalance operations (in_progress only)
   * @returns Simulated future balances after rebalances complete
   */
  protected simulatePendingRebalances(
    rawBalances: RawBalances,
    pendingRebalances: Route[],
  ): RawBalances {
    if (pendingRebalances.length === 0) {
      return rawBalances;
    }

    const simulated = { ...rawBalances };

    for (const rebalance of pendingRebalances) {
      if (rebalance.executionMethod === 'inventory') {
        // Inventory: simulate eventual final state
        const total = rebalance.amount;
        const delivered = rebalance.deliveredAmount ?? 0n;
        const awaiting = rebalance.awaitingDeliveryAmount ?? 0n;

        // Destination: add unfulfilled amount (total - delivered - awaiting)
        // This is what's NOT yet reflected in on-chain balance
        const destinationAdjustment = total - delivered - awaiting;
        if (destinationAdjustment > 0n) {
          simulated[rebalance.destination] =
            (simulated[rebalance.destination] ?? 0n) + destinationAdjustment;

          this.logger.debug(
            {
              context: this.constructor.name,
              destination: rebalance.destination,
              destinationAdjustment: destinationAdjustment.toString(),
            },
            'Simulated inventory rebalance (destination increase for unfulfilled)',
          );
        }

        // Origin: subtract pending amount (total - delivered)
        // This is what WILL decrease when all messages deliver
        const originAdjustment = total - delivered;
        if (originAdjustment > 0n) {
          simulated[rebalance.origin] =
            (simulated[rebalance.origin] ?? 0n) - originAdjustment;

          this.logger.debug(
            {
              context: this.constructor.name,
              origin: rebalance.origin,
              originAdjustment: originAdjustment.toString(),
            },
            'Simulated inventory rebalance (origin decrease for pending)',
          );
        }
      } else {
        // Movable collateral: origin already deducted on-chain, add to destination
        simulated[rebalance.destination] =
          (simulated[rebalance.destination] ?? 0n) + rebalance.amount;

        this.logger.debug(
          {
            context: this.constructor.name,
            destination: rebalance.destination,
            amount: rebalance.amount.toString(),
          },
          'Simulated movable collateral rebalance (destination increase)',
        );
      }
    }

    this.logger.info(
      {
        simulations: pendingRebalances.map((r) => ({
          from: r.origin,
          to: r.destination,
          amount: r.amount.toString(),
          executionMethod: r.executionMethod ?? 'movable_collateral',
          deliveredAmount: r.deliveredAmount?.toString() ?? '0',
          awaitingDeliveryAmount: r.awaitingDeliveryAmount?.toString() ?? '0',
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
    proposedRebalances: Route[],
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

  protected filterRoutes(
    routes: StrategyRoute[],
    actualBalances: RawBalances,
  ): StrategyRoute[] {
    return routes.filter((route) => {
      const balance = actualBalances[route.origin] ?? 0n;
      if (balance < route.amount) {
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
        return false;
      }

      if (this.tokensByChainName) {
        const token = this.tokensByChainName[route.origin];
        if (token) {
          const bridgeConfig = this.getBridgeConfigForRoute(
            route.origin,
            route.destination,
          );
          const minAmount = BigInt(
            toWei(bridgeConfig.bridgeMinAcceptedAmount, token.decimals),
          );
          if (route.amount < minAmount) {
            this.logger.info(
              {
                context: this.constructor.name,
                origin: route.origin,
                destination: route.destination,
                amount: route.amount.toString(),
                minAmount: minAmount.toString(),
              },
              'Dropping route below bridgeMinAcceptedAmount',
            );
            return false;
          }
        }
      }

      return true;
    });
  }
}
