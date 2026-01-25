import { type ChainMap, type ChainName } from '@hyperlane-xyz/sdk';
import type { Address } from '@hyperlane-xyz/utils';

export type RawBalances = ChainMap<bigint>;

export type StrategyRoute = {
  origin: ChainName;
  destination: ChainName;
  amount: bigint;
  bridge?: Address;
};

export type InflightContext = {
  /** In-progress rebalance intents (origin tx confirmed, balance already deducted on-chain) */
  pendingRebalances: StrategyRoute[];
  /** Pending user transfers that need collateral reserved */
  pendingTransfers: StrategyRoute[];
  /** Routes from earlier strategies in same cycle (not yet executed, for CompositeStrategy) */
  proposedRebalances?: StrategyRoute[];
};

export interface IStrategy {
  readonly name: string;
  getRebalancingRoutes(
    rawBalances: RawBalances,
    inflightContext?: InflightContext,
  ): StrategyRoute[];
}
