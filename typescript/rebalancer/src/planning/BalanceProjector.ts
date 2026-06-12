import type { Logger } from 'pino';

import type {
  RawBalances,
  Route,
  RouteWithContext,
} from '../interfaces/IStrategy.js';

type ProjectionLogger = Pick<Logger, 'debug' | 'info'>;

export class BalanceProjector {
  static reserveCollateral(
    rawBalances: RawBalances,
    pendingTransfers: Route[],
    logger?: ProjectionLogger,
    context?: string,
  ): RawBalances {
    if (pendingTransfers.length === 0) {
      return rawBalances;
    }

    const reserved = { ...rawBalances };

    for (const transfer of pendingTransfers) {
      const destBalance = reserved[transfer.destination] ?? 0n;
      reserved[transfer.destination] = destBalance - transfer.amount;

      logger?.debug(
        {
          context,
          destination: transfer.destination,
          amount: transfer.amount.toString(),
          newBalance: reserved[transfer.destination].toString(),
        },
        'Reserved collateral for pending transfer',
      );
    }

    logger?.info(
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

  static simulatePendingRebalances(
    rawBalances: RawBalances,
    pendingRebalances: RouteWithContext[],
    logger?: ProjectionLogger,
    context?: string,
  ): RawBalances {
    if (pendingRebalances.length === 0) {
      return rawBalances;
    }

    const simulated = { ...rawBalances };

    for (const rebalance of pendingRebalances) {
      if (rebalance.executionMethod === 'inventory') {
        const total = rebalance.amount;
        const delivered = rebalance.deliveredAmount ?? 0n;
        const awaiting = rebalance.awaitingDeliveryAmount ?? 0n;
        const destinationAdjustment = total - delivered - awaiting;

        if (destinationAdjustment > 0n) {
          simulated[rebalance.destination] =
            (simulated[rebalance.destination] ?? 0n) + destinationAdjustment;

          logger?.debug(
            {
              context,
              destination: rebalance.destination,
              destinationAdjustment: destinationAdjustment.toString(),
            },
            'Simulated inventory rebalance (destination increase for unfulfilled)',
          );
        }

        const originAdjustment = total - delivered;
        if (originAdjustment > 0n) {
          simulated[rebalance.origin] =
            (simulated[rebalance.origin] ?? 0n) - originAdjustment;

          logger?.debug(
            {
              context,
              origin: rebalance.origin,
              originAdjustment: originAdjustment.toString(),
            },
            'Simulated inventory rebalance (origin decrease for pending)',
          );
        }
      } else {
        simulated[rebalance.destination] =
          (simulated[rebalance.destination] ?? 0n) + rebalance.amount;

        logger?.debug(
          {
            context,
            destination: rebalance.destination,
            amount: rebalance.amount.toString(),
          },
          'Simulated movable collateral rebalance (destination increase)',
        );
      }
    }

    logger?.info(
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

  static simulateProposedRebalances(
    rawBalances: RawBalances,
    proposedRebalances: Route[],
    logger?: ProjectionLogger,
    context?: string,
  ): RawBalances {
    if (proposedRebalances.length === 0) {
      return rawBalances;
    }

    const simulated = { ...rawBalances };

    for (const rebalance of proposedRebalances) {
      simulated[rebalance.origin] =
        (simulated[rebalance.origin] ?? 0n) - rebalance.amount;
      simulated[rebalance.destination] =
        (simulated[rebalance.destination] ?? 0n) + rebalance.amount;

      logger?.debug(
        {
          context,
          origin: rebalance.origin,
          destination: rebalance.destination,
          amount: rebalance.amount.toString(),
        },
        'Simulated proposed rebalance (origin decrease, destination increase)',
      );
    }

    logger?.info(
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
}
