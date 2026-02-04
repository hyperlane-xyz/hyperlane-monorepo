import {
  type EvmMovableCollateralAdapter,
  type TokenAmount,
} from '@hyperlane-xyz/sdk';

import type { StrategyRoute } from './IStrategy.js';

/**
 * RebalanceRoute extends StrategyRoute with a required intentId for tracking.
 * The intentId is assigned by RebalancerService before execution and links
 * to the corresponding RebalanceIntent in the tracking system.
 */
export type RebalanceRoute = StrategyRoute & {
  /** Links to the RebalanceIntent that this route fulfills */
  intentId: string;
};

export type PreparedTransaction = {
  populatedTx: Awaited<
    ReturnType<EvmMovableCollateralAdapter['populateRebalanceTx']>
  >;
  route: RebalanceRoute;
  originTokenAmount: TokenAmount;
};

export type RebalanceMetrics = {
  route: RebalanceRoute;
  originTokenAmount: TokenAmount;
};

export type RebalanceExecutionResult = {
  route: RebalanceRoute;
  success: boolean;
  messageId?: string;
  txHash?: string;
  error?: string;
};

export interface IRebalancer {
  rebalance(routes: RebalanceRoute[]): Promise<RebalanceExecutionResult[]>;
}
