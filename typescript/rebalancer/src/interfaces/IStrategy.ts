import { type ChainMap, type ChainName } from '@hyperlane-xyz/sdk';
import type { Address } from '@hyperlane-xyz/utils';

import { ExternalBridgeType } from '../config/types.js';
import { ExecutionMethod } from '../tracking/types.js';

export type RawBalances = ChainMap<bigint>;

export interface Route {
  origin: ChainName;
  destination: ChainName;
  amount: bigint;
  /** Execution method used for this rebalance */
  executionMethod?: ExecutionMethod;
}

export interface RouteWithContext extends Route {
  /** For inventory intents: sum of complete inventory_deposit actions (message delivered) */
  deliveredAmount?: bigint;
  /** For inventory intents: sum of in_progress inventory_deposit actions (tx confirmed, message pending) */
  awaitingDeliveryAmount?: bigint;
}

/**
 * Route using movable collateral execution (on-chain rebalance via bridge)
 */
export interface MovableCollateralRoute extends Route {
  executionType: 'movableCollateral';
  bridge: Address;
}

/**
 * Route using inventory execution (external bridge + transferRemote)
 */
export interface InventoryRoute extends Route {
  executionType: 'inventory';
  externalBridge: ExternalBridgeType;
}

/**
 * Discriminated union of route types by executionType
 */
export type StrategyRoute = MovableCollateralRoute | InventoryRoute;

/**
 * Type guard to check if a route is a MovableCollateralRoute
 */
export function isMovableCollateralRoute(
  route: StrategyRoute,
): route is MovableCollateralRoute {
  return route.executionType === 'movableCollateral';
}

/**
 * Type guard to check if a route is an InventoryRoute
 */
export function isInventoryRoute(
  route: StrategyRoute,
): route is InventoryRoute {
  return route.executionType === 'inventory';
}

export type InflightContext = {
  /**
   * In-flight rebalances from ActionTracker.
   * Uses Route[] because recovered intents (from Explorer startup recovery)
   * don't have bridge information. Some routes may have bridge at runtime.
   */
  pendingRebalances: RouteWithContext[];
  pendingTransfers: RouteWithContext[];
  /** Routes from earlier strategies - always have bridge */
  proposedRebalances?: StrategyRoute[];
};

export interface IStrategy {
  readonly name: string;
  getRebalancingRoutes(
    rawBalances: RawBalances,
    inflightContext?: InflightContext,
  ): StrategyRoute[];
}
