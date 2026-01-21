import { type ChainMap, type ChainName } from '@hyperlane-xyz/sdk';
import type { Address } from '@hyperlane-xyz/utils';

import type { ExecutionMethod } from '../tracking/types.js';

export type RawBalances = ChainMap<bigint>;

export interface Route {
  origin: ChainName;
  destination: ChainName;
  amount: bigint;
}

export interface StrategyRoute extends Route {
  bridge: Address;
  /** For inventory intents: sum of complete inventory_deposit actions (message delivered) */
  deliveredAmount?: bigint;
  /** For inventory intents: sum of in_progress inventory_deposit actions (tx confirmed, message pending) */
  awaitingDeliveryAmount?: bigint;
  /** Execution method used for this rebalance */
  executionMethod?: ExecutionMethod;
}

export type InflightContext = {
  /**
   * In-flight rebalances from ActionTracker.
   * Uses Route[] because recovered intents (from Explorer startup recovery)
   * don't have bridge information. Some routes may have bridge at runtime.
   */
  pendingRebalances: Route[];
  pendingTransfers: Route[];
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
