import { type ChainMap, type ChainName } from '@hyperlane-xyz/sdk';
import type { Address } from '@hyperlane-xyz/utils';

export type RawBalances = ChainMap<bigint>;

export type RebalancingRoute = {
  origin: ChainName;
  destination: ChainName;
  amount: bigint;
  bridge?: Address;
};

export type InflightContext = {
  /** In-progress rebalance intents (origin tx confirmed, balance already deducted on-chain) */
  pendingRebalances: RebalancingRoute[];
  /** Pending user transfers that need collateral reserved */
  pendingTransfers: RebalancingRoute[];
  /** Routes from earlier strategies in same cycle (not yet executed, for CompositeStrategy) */
  proposedRebalances?: RebalancingRoute[];
};

export interface IStrategy {
  readonly name: string;
  getRebalancingRoutes(
    rawBalances: RawBalances,
    inflightContext?: InflightContext,
  ): RebalancingRoute[];
}
