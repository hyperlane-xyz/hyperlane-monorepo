import { ChainMap, ChainName } from '@hyperlane-xyz/sdk';

export type RawBalances = ChainMap<bigint>;

export type RebalancingRoute = {
  origin: ChainName;
  destination: ChainName;
  amount: bigint;
  /** Optional bridge address for this route */
  bridge?: string;
};

/**
 * Context containing inflight messages for strategy decision making
 */
export type InflightContext = {
  /** Pending user warp transfers that need collateral at destination */
  pendingTransfers: RebalancingRoute[];
  /** Pending rebalances (initiated by rebalancer or manually) */
  pendingRebalances: RebalancingRoute[];
};

export interface IStrategy {
  /**
   * Get rebalancing routes based on current balances
   * @param rawBalances Current on-chain balances
   * @param inflightContext Optional context about inflight messages
   */
  getRebalancingRoutes(
    rawBalances: RawBalances,
    inflightContext?: InflightContext,
  ): RebalancingRoute[];
}
