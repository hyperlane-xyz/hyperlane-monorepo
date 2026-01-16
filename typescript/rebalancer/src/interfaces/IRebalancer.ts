import {
  type EvmMovableCollateralAdapter,
  type TokenAmount,
} from '@hyperlane-xyz/sdk';

import { type RebalancingRoute } from './IStrategy.js';

export type PreparedTransaction = {
  populatedTx: Awaited<
    ReturnType<EvmMovableCollateralAdapter['populateRebalanceTx']>
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
