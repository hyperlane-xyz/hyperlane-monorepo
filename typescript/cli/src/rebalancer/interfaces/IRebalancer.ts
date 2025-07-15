import { EvmHypCollateralAdapter, TokenAmount } from '@hyperlane-xyz/sdk';

import { RebalancingRoute } from './IStrategy.js';

export type PreparedTransaction = {
  populatedTx: Awaited<
    ReturnType<EvmHypCollateralAdapter['populateRebalanceTx']>
  >;
  route: RebalancingRoute;
  originTokenAmount: TokenAmount;
};

export type RebalanceMetrics = {
  route: RebalancingRoute;
  originTokenAmount: TokenAmount;
};

export interface IRebalancer {
  rebalance(routes: RebalancingRoute[]): Promise<void>;
}
