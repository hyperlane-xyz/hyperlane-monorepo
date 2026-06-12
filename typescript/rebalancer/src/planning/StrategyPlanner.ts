import type { Logger } from 'pino';

import type { ChainMap, Token } from '@hyperlane-xyz/sdk';

import type { RawBalances, StrategyRoute } from '../interfaces/IStrategy.js';
import type { Metrics } from '../metrics/Metrics.js';
import { normalizeConfiguredAmount } from '../utils/balanceUtils.js';
import {
  getRouteExecutionConfig,
  type RouteExecutionMatrix,
} from '../utils/bridgeUtils.js';

type PlannerLogger = Pick<Logger, 'debug' | 'info' | 'warn'>;

export class StrategyPlanner {
  constructor(
    private readonly routeExecutionMatrix: RouteExecutionMatrix,
    private readonly logger: PlannerLogger,
    private readonly metrics?: Metrics,
    private readonly tokensByChainName?: ChainMap<Token>,
  ) {}

  finalizeRoutes(
    routes: StrategyRoute[],
    actualBalances: RawBalances,
    strategyName: string,
    context: string,
  ): StrategyRoute[] {
    const filteredRoutes = this.filterRoutes(routes, actualBalances, context);

    this.logger.debug(
      {
        context,
        filteredRoutesCount: filteredRoutes.length,
        droppedCount: routes.length - filteredRoutes.length,
      },
      'Filtered rebalancing routes',
    );

    for (const route of filteredRoutes) {
      this.metrics?.recordIntentCreated(route, strategyName);
    }

    return filteredRoutes;
  }

  private filterRoutes(
    routes: StrategyRoute[],
    actualBalances: RawBalances,
    context: string,
  ): StrategyRoute[] {
    return routes.filter((route) => {
      const balance = actualBalances[route.origin] ?? 0n;
      if (balance < route.amount) {
        this.logger.warn(
          {
            context,
            origin: route.origin,
            destination: route.destination,
            required: route.amount.toString(),
            available: balance.toString(),
          },
          'Dropping route due to insufficient balance',
        );
        return false;
      }

      const token = this.tokensByChainName?.[route.origin];
      if (token) {
        const bridgeConfig = getRouteExecutionConfig(
          this.routeExecutionMatrix,
          route.origin,
          route.destination,
        );
        if (bridgeConfig.bridgeMinAcceptedAmount != null) {
          const minAmount = normalizeConfiguredAmount(
            bridgeConfig.bridgeMinAcceptedAmount,
            token,
          );
          if (route.amount < minAmount) {
            this.logger.info(
              {
                context,
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
