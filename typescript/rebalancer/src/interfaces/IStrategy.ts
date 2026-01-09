import { type ChainMap, type ChainName } from '@hyperlane-xyz/sdk';

export type RawBalances = ChainMap<bigint>;

export type RebalancingRoute = {
  origin: ChainName;
  destination: ChainName;
  amount: bigint;
};

export type InflightContext = {
  pendingRebalances: RebalancingRoute[];
  pendingTransfers: RebalancingRoute[];
};

export interface IStrategy {
  getRebalancingRoutes(
    rawBalances: RawBalances,
    inflightContext?: InflightContext,
  ): RebalancingRoute[];
}
