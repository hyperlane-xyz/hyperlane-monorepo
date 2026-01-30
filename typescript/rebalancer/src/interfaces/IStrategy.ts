import { type ChainMap, type ChainName } from '@hyperlane-xyz/sdk';
import type { Address } from '@hyperlane-xyz/utils';

export type RawBalances = ChainMap<bigint>;

export interface Route {
  origin: ChainName;
  destination: ChainName;
  amount: bigint;
}

export interface StrategyRoute extends Route {
  bridge: Address;
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
