import type { Logger } from 'pino';

import type { MultiProvider } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import type { InventoryExecutionResult } from '../../interfaces/IRebalancer.js';
import type { InventoryRoute } from '../../interfaces/IStrategy.js';
import type { IActionTracker } from '../../tracking/IActionTracker.js';
import type {
  PartialInventoryIntent,
  RebalanceIntent,
} from '../../tracking/types.js';

export class InventoryIntentResolver {
  constructor(
    private readonly actionTracker: IActionTracker,
    private readonly multiProvider: MultiProvider,
    private readonly executeRoute: (
      route: InventoryRoute,
      intent: RebalanceIntent,
    ) => Promise<InventoryExecutionResult>,
    private readonly consumeSuccessfulRoute: (
      route: InventoryRoute,
      result: InventoryExecutionResult,
    ) => void,
    private readonly logger: Logger,
  ) {}

  async rebalance(
    routes: InventoryRoute[],
  ): Promise<InventoryExecutionResult[]> {
    const activeIntent = await this.getActiveInventoryIntent();

    if (activeIntent) {
      if (activeIntent.hasInflightDeposit) {
        this.logger.info(
          {
            intentId: activeIntent.intent.id,
            remaining: activeIntent.remaining.toString(),
          },
          'Active intent has in-flight deposit, waiting for delivery before continuing',
        );
        return [];
      }
      this.logger.info(
        {
          intentId: activeIntent.intent.id,
          remaining: activeIntent.remaining.toString(),
          newRoutesIgnored: routes.length,
        },
        'Continuing existing intent, ignoring new routes',
      );
      return this.continueIntent(activeIntent);
    }

    if (routes.length === 0) return [];

    const route = routes[0];
    if (routes.length > 1) {
      this.logger.info(
        {
          selectedRoute: `${route.origin} → ${route.destination}`,
          discardedCount: routes.length - 1,
        },
        'Taking first route only, discarding others',
      );
    }

    const intent = await this.actionTracker.createRebalanceIntent({
      origin: this.multiProvider.getDomainId(route.origin),
      destination: this.multiProvider.getDomainId(route.destination),
      amount: route.amount,
      executionMethod: 'inventory',
      externalBridge: route.externalBridge,
    });

    this.logger.debug(
      {
        intentId: intent.id,
        origin: route.origin,
        destination: route.destination,
        amount: route.amount.toString(),
      },
      'Created new inventory rebalance intent',
    );

    try {
      const result = await this.executeRoute(route, intent);
      this.consumeSuccessfulRoute(route, result);
      return [result];
    } catch (error) {
      this.logger.error(
        {
          route,
          intentId: intent.id,
          error: (error as Error).message,
        },
        'Failed to execute inventory route',
      );

      return [
        {
          route,
          success: false,
          error: (error as Error).message,
        },
      ];
    }
  }

  private async getActiveInventoryIntent(): Promise<PartialInventoryIntent | null> {
    const partialIntents =
      await this.actionTracker.getPartiallyFulfilledInventoryIntents();
    return partialIntents.length > 0 ? partialIntents[0] : null;
  }

  private async continueIntent(
    partial: PartialInventoryIntent,
  ): Promise<InventoryExecutionResult[]> {
    const { intent, remaining } = partial;
    assert(
      intent.externalBridge,
      `Inventory intent ${intent.id} is missing externalBridge`,
    );

    const route: InventoryRoute = {
      origin: this.multiProvider.getChainName(intent.origin),
      destination: this.multiProvider.getChainName(intent.destination),
      amount: remaining,
      executionType: 'inventory',
      externalBridge: intent.externalBridge,
    };

    this.logger.info(
      {
        intentId: intent.id,
        origin: route.origin,
        destination: route.destination,
        remaining: remaining.toString(),
        completed: partial.completedAmount.toString(),
        total: intent.amount.toString(),
      },
      'Continuing partial inventory intent',
    );

    if (intent.status === 'not_started') {
      this.logger.warn(
        {
          intentId: intent.id,
          origin: route.origin,
          destination: route.destination,
        },
        'Retrying intent that never started - previous execution attempt failed without creating any actions',
      );
    }

    try {
      const result = await this.executeRoute(route, intent);
      this.consumeSuccessfulRoute(route, result);
      return [result];
    } catch (error) {
      this.logger.error(
        {
          route,
          intentId: intent.id,
          error: (error as Error).message,
        },
        'Failed to continue partial inventory intent',
      );

      return [
        {
          route,
          success: false,
          error: (error as Error).message,
        },
      ];
    }
  }
}
