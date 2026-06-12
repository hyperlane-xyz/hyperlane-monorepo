import type { ChainName } from '@hyperlane-xyz/sdk';

import type { StrategyRoute } from '../interfaces/IStrategy.js';
import {
  createStrategyRoute,
  getRouteExecutionConfig,
  type RouteExecutionMatrix,
} from '../utils/bridgeUtils.js';

import type { BalanceDelta } from './types.js';

export function materializeStrategyRoute(
  routeExecutionMatrix: RouteExecutionMatrix,
  origin: ChainName,
  destination: ChainName,
  amount: bigint,
): StrategyRoute {
  return createStrategyRoute(
    getRouteExecutionConfig(routeExecutionMatrix, origin, destination),
    origin,
    destination,
    amount,
  );
}

export function planRoutes(
  surpluses: BalanceDelta[],
  deficits: BalanceDelta[],
  routeExecutionMatrix: RouteExecutionMatrix,
): StrategyRoute[] {
  const routes: StrategyRoute[] = [];

  while (deficits.length > 0 && surpluses.length > 0) {
    const surplus = surpluses[0];
    const deficit = deficits[0];
    const transferAmount =
      surplus.amount > deficit.amount ? deficit.amount : surplus.amount;

    if (transferAmount > 0n) {
      routes.push(
        materializeStrategyRoute(
          routeExecutionMatrix,
          surplus.chain,
          deficit.chain,
          transferAmount,
        ),
      );
    }

    deficit.amount -= transferAmount;
    surplus.amount -= transferAmount;

    if (deficit.amount <= 0n) {
      deficits.shift();
    }

    if (surplus.amount <= 0n) {
      surpluses.shift();
    }
  }

  return routes;
}
