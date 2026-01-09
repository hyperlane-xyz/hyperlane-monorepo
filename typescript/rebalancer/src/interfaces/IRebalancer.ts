import type { PopulatedTransaction } from 'ethers';

import type { TokenAmount } from '@hyperlane-xyz/sdk';

import type { RebalancingRoute } from './IStrategy.js';

export type PreparedTransaction = {
  /** Array of transactions: [approvalTx?, rebalanceTx] */
  populatedTxs: PopulatedTransaction[];
  route: RebalancingRoute;
  originTokenAmount: TokenAmount;
};

export type RebalanceMetrics = {
  route: RebalancingRoute;
  originTokenAmount: TokenAmount;
};

export type RebalanceExecutionResult = {
  route: RebalancingRoute;
  success: boolean;
  messageId?: string;
  txHash?: string;
  error?: string;
};

export interface IRebalancer {
  rebalance(routes: RebalancingRoute[]): Promise<RebalanceExecutionResult[]>;
}
